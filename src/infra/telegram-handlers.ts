import type { Sql, TransactionSql } from 'postgres';
import { hashSessionToken } from '../lib/crypto';
import { recordAudit } from '../lib/audit';
import { enqueueOutbox, suppressJobsForAccountChannel } from './outbox';
import { recommendForEvent } from '../domain/recommendations';

/**
 * Inbound Telegram update processing (worker handler for kind 'telegram_update').
 * The webhook already durably accepted the event; this is the async side.
 *
 * Rules (spec 01 S04, 04 §8, AC-11/39):
 *   - Bindings resolve by (provider='telegram', external_id=chat id).
 *   - A binding is created ONLY from a telegram_link challenge that BOTH the
 *     web session confirmed (proof_flags.web_confirmed) AND Telegram /start
 *     presented. A stolen token alone is insufficient (AC-11).
 *   - /start is NEVER consent: zero consent_events rows are ever written here.
 *   - /stop revokes the binding and suppresses all queued sends on the channel.
 *   - No dialog with strangers: unknown binding + non-/start text → ignore.
 */

type SqlLike = Sql | TransactionSql;

export interface TelegramUpdatePayload {
  update_id: number;
  chat_id: number | string;
  from_id?: number | string | null;
  text?: string | null;
  message_id?: number | null;
}

/** Extracts `/start link_<token>` payload; null when absent/malformed. */
export function extractStartToken(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /^\/start\s+link_([A-Za-z0-9_-]{20,512})$/.exec(text.trim());
  return m?.[1] ?? null;
}

export function startsWithCommand(text: string | null | undefined, command: string): boolean {
  if (!text) return false;
  return text.trim().toLowerCase().startsWith(command);
}

const COPY = {
  help: [
    'WELCOME — команды:',
    '/matches — сколько рекомендаций для вас',
    '/privacy — как WELCOME обращается с данными',
    '/stop — отключить автоматические сообщения',
    '/delete — как удалить аккаунт',
  ].join('\n'),
  start_no_token:
    'Привяжите Telegram к вашему WELCOME-аккаунту: откройте WELCOME в браузере → «Telegram», подтвердите привязку и нажмите Start по ссылке оттуда.\n\n' +
    'Важно: Start — это НЕ согласие ни на что. Согласия оформляются только в веб-приложении.',
  start_link_bad:
    'Ссылка недействительна или истекла (срок жизни — 10 минут). Получите новую в WELCOME и повторите.\n\n' +
    'Start — это НЕ согласие ни на что.',
  start_link_unconfirmed:
    'Ссылка получена, но подтверждение из веб-сессии не найдено. Откройте WELCOME в браузере, подтвердите привязку и нажмите Start ещё раз. Привязка создаётся только после двух подтверждений.',
  linked: 'WELCOME: Telegram привязан. Команды: /help',
  stop: 'Автоматические сообщения WELCOME отключены. Очередь на отправку очищена. Заново привязать канал можно через WELCOME в браузере.',
  privacy:
    'WELCOME хранит минимум данных, контакты шифруются, а сообщения не содержат приватных значений. Политика и управление согласиями — в веб-приложении: раздел «Приватность».',
  delete:
    'Удаление аккаунта выполняется в веб-приложении WELCOME: раздел «Приватность» → «Удалить аккаунт». Бот не удаляет данные командой.',
  no_event: 'Пока нет активного события. Присоединитесь к событию в WELCOME, чтобы видеть рекомендации.',
  matches_prefix: 'WELCOME: рекомендаций сейчас:',
};

/** Processes one durable telegram_update job. Idempotent per update_id (dedupe at enqueue + reply keys). */
export async function handleTelegramUpdate(sql: Sql, payload: TelegramUpdatePayload): Promise<string> {
  const chatId = String(payload.chat_id);
  const text = typeof payload.text === 'string' ? payload.text : null;

  const bindingRows = await sql<{ id: string; account_id: string; state: string }[]>`
    SELECT id, account_id, state FROM channel_bindings
    WHERE provider = 'telegram' AND external_id = ${chatId}
    LIMIT 1
  `;
  const binding = bindingRows[0];

  if (binding && binding.state === 'active') {
    await sql`UPDATE channel_bindings SET last_inbound_at = now() WHERE id = ${binding.id}`;
    return handleKnownCommand(sql, binding.account_id, chatId, text, payload.update_id);
  }

  // Unknown (or revoked) binding: only the two-sided /start flow is served.
  if (startsWithCommand(text, '/start')) {
    return handleStartLink(sql, chatId, extractStartToken(text));
  }
  // No dialog with strangers (and no re-engagement of revoked channels).
  return 'ignored_stranger';
}

async function handleKnownCommand(
  sql: Sql,
  accountId: string,
  chatId: string,
  text: string | null,
  updateId: number,
): Promise<string> {
  if (startsWithCommand(text, '/stop')) {
    await sql.begin(async (tx) => {
      const updated = await tx<{ id: string }[]>`
        UPDATE channel_bindings SET state = 'revoked'
        WHERE account_id = ${accountId} AND provider = 'telegram' AND state = 'active'
        RETURNING id
      `;
      await recordAudit(tx, accountId, 'channel.revoked', 'channel_binding', updated[0]?.id ?? null, {
        provider: 'telegram',
        via: '/stop',
      });
      await suppressJobsForAccountChannel(tx, accountId, 'telegram', 'channel_revoked');
    });
    await enqueueReply(sql, { chatId, text: COPY.stop, updateId });
    return 'stopped';
  }
  if (startsWithCommand(text, '/privacy')) {
    await enqueueReply(sql, { chatId, text: COPY.privacy, updateId });
    return 'privacy';
  }
  if (startsWithCommand(text, '/help')) {
    await enqueueReply(sql, { chatId, text: COPY.help, updateId });
    return 'help';
  }
  if (startsWithCommand(text, '/delete')) {
    await enqueueReply(sql, { chatId, text: COPY.delete, updateId });
    return 'delete';
  }
  if (startsWithCommand(text, '/matches')) {
    return handleMatches(sql, accountId, chatId, updateId);
  }
  await enqueueReply(sql, { chatId, text: COPY.help, updateId });
  return 'fallback_help';
}

/** /matches: recommendation COUNT only — no contact data, no other people's ids. */
async function handleMatches(sql: Sql, accountId: string, chatId: string, updateId: number): Promise<string> {
  const membershipRows = await sql<{ event_id: string; profile_id: string; event_name: string | null }[]>`
    SELECT m.event_id, m.profile_id, e.name AS event_name
    FROM event_memberships m
    JOIN profiles p ON p.id = m.profile_id
    JOIN events e ON e.id = m.event_id
    WHERE p.account_id = ${accountId} AND m.state = 'active'
    ORDER BY m.created_at DESC
    LIMIT 1
  `;
  const membership = membershipRows[0];
  if (!membership) {
    await enqueueReply(sql, { chatId, text: COPY.no_event, updateId });
    return 'matches_none';
  }
  const recs = await recommendForEvent(sql, { accountId, profileId: membership.profile_id }, membership.event_id, 3);
  await enqueueReply(sql, {
    chatId,
    text: `${COPY.matches_prefix} ${recs.length}. Детали — в WELCOME${membership.event_name ? ` (событие «${membership.event_name}») ` : ''}:`,
    updateId,
  });
  return 'matches_count';
}

/**
 * /start link_<token>: completes the two-sided binding when the challenge is
 * valid, unconsumed, unexpired AND already confirmed from the web session.
 */
async function handleStartLink(sql: Sql, chatId: string, token: string | null): Promise<string> {
  if (!token) {
    await enqueueReply(sql, { chatId, text: COPY.start_no_token });
    return 'start_no_token';
  }

  const tokenHash = hashSessionToken(token);
  const challengeRows = await sql<{ id: string; account_id: string | null; proof_flags: Record<string, unknown> }[]>`
    SELECT id, account_id, proof_flags FROM link_challenges
    WHERE token_hash = ${tokenHash} AND purpose = 'telegram_link'
      AND consumed_at IS NULL AND expires_at > now()
    LIMIT 1
  `;
  const challenge = challengeRows[0];
  if (!challenge || !challenge.account_id) {
    await enqueueReply(sql, { chatId, text: COPY.start_link_bad });
    return 'start_link_invalid';
  }
  if (challenge.proof_flags['web_confirmed'] !== true) {
    // AC-11: the Telegram-side token alone is insufficient — no binding.
    await enqueueReply(sql, { chatId, text: COPY.start_link_unconfirmed });
    return 'start_link_unconfirmed';
  }

  return sql.begin<string>(async (tx) => {
    // Re-check under lock: only one /start consumes the challenge.
    const locked = await tx<{ id: string }[]>`
      SELECT id FROM link_challenges
      WHERE id = ${challenge.id} AND consumed_at IS NULL AND expires_at > now()
        AND proof_flags->>'web_confirmed' = 'true'
      FOR UPDATE
    `;
    if (!locked[0]) return 'start_link_race';

    await tx`UPDATE link_challenges SET consumed_at = now() WHERE id = ${challenge.id}`;
    await upsertTelegramBinding(tx, challenge.account_id!, chatId);
    await recordAudit(tx, challenge.account_id, 'channel.linked', 'channel_binding', null, {
      provider: 'telegram',
      challenge_id: challenge.id,
    });
    await enqueueOutbox(tx, {
      dedupeKey: `tg_link_confirm:${challenge.id}`,
      kind: 'telegram_reply',
      subjectId: challenge.id,
      channel: 'telegram',
      purpose: 'service_channel',
      payload: { chat_id: chatId, text: COPY.linked },
    });
    return 'bound';
  });
}

/**
 * Upserts the binding with both uniqueness directions handled:
 * (provider, external_id) — one chat belongs to one account;
 * (account_id, provider)  — one account has one chat per provider.
 * A conflicting older binding on the account side is revoked, never silently reused.
 */
export async function upsertTelegramBinding(tx: SqlLike, accountId: string, chatId: string): Promise<string> {
  const upsert = async (): Promise<{ id: string }[]> =>
    tx<{ id: string }[]>`
      INSERT INTO channel_bindings (account_id, provider, external_id, state)
      VALUES (${accountId}, 'telegram', ${chatId}, 'active')
      ON CONFLICT (provider, external_id)
      DO UPDATE SET account_id = EXCLUDED.account_id, state = 'active'
      RETURNING id
    `;
  try {
    const rows = await upsert();
    if (rows[0]) return rows[0].id;
    throw new Error('binding upsert returned no row');
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // The account already holds a binding to another chat: revoke it, then retry.
    await tx`
      UPDATE channel_bindings SET state = 'revoked'
      WHERE account_id = ${accountId} AND provider = 'telegram' AND external_id <> ${chatId}
    `;
    const rows = await upsert();
    if (rows[0]) return rows[0].id;
    throw new Error('binding upsert failed after conflict resolution');
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

interface ReplyInput {
  chatId: string;
  text: string;
  updateId?: number;
}

/** Reply jobs are deduped per chat+text+update so retries never double-send. */
async function enqueueReply(sql: SqlLike, input: ReplyInput): Promise<void> {
  const dedupeKey = input.updateId !== undefined
    ? `tg_reply:${input.chatId}:${input.updateId}`
    : `tg_stranger_reply:${input.chatId}:${input.text.length}:${hashKey(input.text)}`;
  await enqueueOutbox(sql, {
    dedupeKey,
    kind: 'telegram_reply',
    subjectId: null,
    channel: 'telegram',
    purpose: 'service_channel',
    payload: { chat_id: input.chatId, text: input.text },
  });
}

function hashKey(text: string): string {
  return Buffer.from(text, 'utf8').subarray(0, 24).toString('base64url');
}

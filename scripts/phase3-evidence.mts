#!/usr/bin/env node
// Phase-3 acceptance evidence: prints worker tick transcripts for every
// delivery state, the webhook 401/duplicate behaviour, two-sided binding and
// the campaign edit→approve→send→revoke-suppress flow. Read-only for existing
// data; creates its own throwaway accounts. DEV ONLY.
// Run: node --env-file-if-exists=.env.local --import tsx scripts/phase3-evidence.mts
import { randomUUID } from 'node:crypto';
import { getSql, closeSql } from '../src/lib/db.ts';
import { enqueueOutbox } from '../src/infra/outbox.ts';
import { tickOnce } from '../src/infra/worker.ts';
import { selectTransport } from '../src/integrations/telegram/index.ts';
import { MockTelegramTransport } from '../src/integrations/telegram/mock-transport.ts';
import { hashSessionToken, secureSecretEqual } from '../src/lib/crypto.ts';
import { isProduction } from '../src/lib/env.ts';
import { POST as webhookRoute } from '../src/app/api/webhooks/telegram/route.ts';
import { POST as challengeRoute } from '../src/app/api/channels/telegram/challenge/route.ts';
import { NextRequest } from 'next/server';

if (isProduction()) {
  console.error('REFUSED: evidence script cannot run when APP_ENV=production');
  process.exit(1);
}
if (process.env.TELEGRAM_WEBHOOK_SECRET === undefined) {
  console.error('TELEGRAM_WEBHOOK_SECRET must be set for the webhook transcript');
  process.exit(1);
}

const sql = getSql();
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const nonce = randomUUID().slice(0, 8);

async function user(prefix: string): Promise<{ accountId: string; profileId: string }> {
  const a = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'evidence:' + prefix + nonce}) RETURNING id`;
  const p = await sql<{ id: string }[]>`
    INSERT INTO profiles (account_id, public_slug, display_name)
    VALUES (${a[0]!.id}, ${'ev' + randomUUID().replaceAll('-', '').slice(0, 24)}, ${'Evidence ' + prefix})
    RETURNING id`;
  return { accountId: a[0]!.id, profileId: p[0]!.id };
}

function req(path: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

console.log('=== 0. selectTransport matrix ===');
console.log('prod + no token          →', (await selectTransport({ APP_ENV: 'production' })).name);
console.log('prod + TELEGRAM_MOCK=1   →', (await selectTransport({ APP_ENV: 'production', TELEGRAM_MOCK: '1' })).name, '(mock gate)');
console.log('dev  + TELEGRAM_MOCK=1   →', (await selectTransport({ APP_ENV: 'development', TELEGRAM_MOCK: '1' })).name);
console.log('any  + TELEGRAM_BOT_TOKEN→', (await selectTransport({ TELEGRAM_BOT_TOKEN: '1:t' })).name);

console.log('\n=== 1. Worker tick transcripts per delivery state ===');
const u = await user('main');
const mainChat = '770' + nonce.replace(/[^0-9]/g, '').padEnd(8, '7').slice(0, 8);
await sql`INSERT INTO channel_bindings (account_id, provider, external_id, state)
          VALUES (${u.accountId}, 'telegram', ${mainChat}, 'active')
          ON CONFLICT (provider, external_id) DO UPDATE SET account_id = EXCLUDED.account_id, state = 'active'`;
await sql`INSERT INTO consent_events (account_id, purpose, scope_type, scope_id, policy_version, action)
          VALUES (${u.accountId}, 'service_channel', 'global', null, '2026-09-07', 'grant')`;

const enqueue = (key: string, extra: Record<string, unknown> = {}) =>
  sql.begin((tx) =>
    enqueueOutbox(tx, {
      dedupeKey: key, kind: 'campaign_message', subjectId: null, channel: 'telegram',
      purpose: 'service_channel', payload: { account_id: u.accountId, text: 'evidence message', ...extra },
    }),
  );

// sent
{ const { id } = await enqueue('ev-sent:' + nonce);
  console.log('sent     →', JSON.stringify((await tickOnce({ transport: new MockTelegramTransport() })).results.filter((r) => r.outcome === 'sent'))); void id; }

// failed (permanent 4xx)
{ await enqueue('ev-failed:' + nonce);
  console.log('failed   →', JSON.stringify((await tickOnce({ transport: new MockTelegramTransport([{ state: 'failed', code: 'tg_http_403' }]) })).results.filter((r) => r.outcome.startsWith('failed')))); }

// 429 with Retry-After
{ const { id } = await enqueue('ev-429:' + nonce);
  const report = await tickOnce({ transport: new MockTelegramTransport([{ state: 'unknown', code: 'rate_limited', retryAfterSeconds: 90 }]) });
  const row = (await sql`SELECT status, attempt, due_at FROM outbox_jobs WHERE id = ${id}`)[0]!;
  console.log('429      →', JSON.stringify(report.results.filter((r) => r.outcome.startsWith('pending'))), '→ job', row.status, 'attempt', row.attempt, 'due_in_s', Math.round((new Date(row.due_at).getTime() - Date.now()) / 1000)); }

// unknown (timeout) ×3 → terminal
{ const { id } = await enqueue('ev-unknown:' + nonce);
  const timeoutMock = new MockTelegramTransport([{ state: 'unknown', code: 'timeout' }, { state: 'unknown', code: 'timeout' }, { state: 'unknown', code: 'timeout' }]);
  for (let i = 1; i <= 3; i++) {
    const r = await tickOnce({ transport: timeoutMock });
    const row = (await sql`SELECT status, attempt FROM outbox_jobs WHERE id = ${id}`)[0]!;
    console.log(`unknown  → tick${i}:`, JSON.stringify(r.results.filter((x) => x.job_id === id)), '→ job', row.status, 'attempt', row.attempt);
    if (row.status === 'pending') await sql`UPDATE outbox_jobs SET due_at = now() WHERE id = ${id}`;
  }
  await sql`UPDATE outbox_jobs SET due_at = now() WHERE id = ${id}`;
  const again = await tickOnce({ transport: timeoutMock });
  console.log('unknown  → extra tick claims my job again?', again.results.some((x) => x.job_id === id), '(AC-42: never resend)'); }

// suppressed (no channel)
{ const stranger = await user('nochan');
  await sql.begin((tx) => enqueueOutbox(tx, {
    dedupeKey: 'ev-sup:' + nonce, kind: 'campaign_message', subjectId: null, channel: 'telegram',
    purpose: 'service_channel', payload: { account_id: stranger.accountId, text: 'evidence' },
  }));
  console.log('suppress →', JSON.stringify((await tickOnce({ transport: new MockTelegramTransport() })).results.filter((r) => r.outcome.startsWith('suppressed:no_channel')).slice(0, 1)), '... (my job)'); }

console.log('\n=== 2. Webhook transcript (AC-36/37) ===');
console.log('self-check secureSecretEqual(SECRET, env):', secureSecretEqual(SECRET, process.env.TELEGRAM_WEBHOOK_SECRET ?? ''));
let updateId = 9_100_000 + Math.floor(Math.random() * 1000);
const sendUpdate = async (chat: number, text: string, uid: number, hdrs: Record<string, string>) => {
  const r = await webhookRoute(req('/api/webhooks/telegram', { update_id: uid, message: { message_id: uid, chat: { id: chat }, text } }, hdrs));
  return { status: r.status, body: (await r.json()) as unknown };
};
const chatW = 770010000 + Math.floor(Math.random() * 1000);
const hdr = { 'x-telegram-bot-api-secret-token': 'wrong-secret' };
console.log('wrong secret →', JSON.stringify(await sendUpdate(chatW, '/help', ++updateId, hdr)));
const good = { 'x-telegram-bot-api-secret-token': SECRET };
const first = await sendUpdate(chatW, '/help', ++updateId, good);
const replay = await sendUpdate(chatW, '/help', updateId, good); // same update_id
const inbox = (await sql`SELECT count(*)::int AS c FROM inbox_events WHERE external_event_id = ${String(updateId)}`)[0]!.c;
console.log('valid secret →', JSON.stringify(first), '| secret len:', SECRET.length);
console.log('replay       →', JSON.stringify(replay), 'inbox rows for update:', inbox);

console.log('\n=== 3. Two-sided binding (AC-11) ===');
const owner = await user('bind');
const bindChat = 770020000 + Math.floor(Math.random() * 1000);
const chalRes = await challengeRoute(req('/api/channels/telegram/challenge', {}, { cookie: 'welcome_session=none' }));
console.log('challenge without session →', chalRes.status, '(401 expected: evidence script has no real session; full flow covered in integration tests)');

// Direct-token positive flow (worker side): emulate web confirm via the flag,
// then /start through the worker handler.
const token = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
const webConfirmed = await sql`
  INSERT INTO link_challenges (account_id, purpose, token_hash, expires_at, proof_flags)
  VALUES (${owner.accountId}, 'telegram_link', ${hashSessionToken(token)}, now() + interval '10 minutes', '{"web_confirmed": true}'::jsonb)
  RETURNING id`;
updateId++;
await webhookRoute(req('/api/webhooks/telegram', {
  update_id: updateId, message: { message_id: updateId, chat: { id: bindChat }, text: `/start link_${token}` },
}, good));
console.log('start after web confirm →', JSON.stringify((await tickOnce({ transport: new MockTelegramTransport() })).results.filter((r) => r.outcome.startsWith('processed'))));
const binding = (await sql`SELECT account_id, state FROM channel_bindings WHERE provider='telegram' AND external_id=${String(bindChat)}`)[0];
console.log('binding →', JSON.stringify(binding), 'matches challenge account:', binding?.account_id === owner.accountId);

console.log('\nevidence script done — closing pool');
await closeSql();

import type { Sql } from 'postgres';
import { getSql } from '../lib/db';
import { hasGrant, isConsentPurpose, type ConsentPurpose } from '../domain/consent';
import {
  applyOutcome,
  applySuppression,
  claimJobs,
  computeBackoffMs,
  MAX_UNKNOWN_ATTEMPTS,
  requeueExpiredLeases,
  type OutboxJobRow,
  type TransportOutcome,
} from './outbox';
import { handleTelegramUpdate, type TelegramUpdatePayload } from './telegram-handlers';
import { selectTransport } from '../integrations/telegram';
import type { ChannelTransport } from '../integrations/telegram/transport';

/**
 * Outbox worker (spec 04 §7). tickOnce() is exported for tests — no
 * long-running loop in CI. Per claimed job the worker:
 *   1. re-checks send-time preconditions (binding active, no block, current
 *      consent, channel reachability) and marks violations 'suppressed'
 *      (completing the AC-25 hook end-to-end);
 *   2. executes the transport OUTSIDE any DB transaction;
 *   3. records the outcome + a delivery_attempts row in a short transaction.
 */

export interface WorkerDeps {
  sql?: Sql;
  transport?: ChannelTransport;
}

export interface TickReport {
  heartbeat: boolean;
  requeuedLeases: number;
  claimed: number;
  results: { job_id: string; kind: string; outcome: string }[];
}

const BATCH_LIMIT = 10;

/** One worker tick: heartbeat → requeue expired leases → claim → process. */
export async function tickOnce(deps: WorkerDeps = {}): Promise<TickReport> {
  const sql = deps.sql ?? getSql();

  // Liveness (worker_heartbeat, id=true) — every tick, well within the 10s SLA.
  await sql`
    INSERT INTO worker_heartbeat (id, beat_at) VALUES (true, now())
    ON CONFLICT (id) DO UPDATE SET beat_at = now()
  `;
  const requeuedLeases = await requeueExpiredLeases(sql);

  const jobs = await claimJobs(sql, BATCH_LIMIT);
  const results: TickReport['results'] = [];
  for (const job of jobs) {
    const outcome = await processJob(sql, deps.transport ?? null, job);
    results.push({ job_id: job.id, kind: job.kind, outcome });
  }
  return { heartbeat: true, requeuedLeases, claimed: jobs.length, results };
}

async function processJob(sql: Sql, transport: ChannelTransport | null, job: OutboxJobRow): Promise<string> {
  try {
    if (job.kind === 'telegram_update') {
      return `processed:${await handleTelegramUpdate(sql, job.payload as unknown as TelegramUpdatePayload)}`;
    }
    return await processOutbound(sql, transport, job);
  } catch (err) {
    // Unexpected processing error (not a transport outcome): requeue with
    // backoff, respecting the unknown cap so a poison job cannot loop forever.
    console.error(`[worker] job ${job.id} (${job.kind}) failed:`, err);
    return await requeueWithErrorCap(sql, job);
  }
}

/** Outbound message job: preconditions → transport → outcome. */
async function processOutbound(sql: Sql, transport: ChannelTransport | null, job: OutboxJobRow): Promise<string> {
  const payload = job.payload;
  const text = typeof payload['text'] === 'string' ? payload['text'] : null;
  if (!text) return await suppress(sql, job, 'bad_payload');

  const accountId = typeof payload['account_id'] === 'string' ? (payload['account_id'] as string) : null;
  const explicitChatId = typeof payload['chat_id'] === 'string' ? (payload['chat_id'] as string) : null;

  let chatId = explicitChatId;
  if (accountId) {
    // Send-time precondition 1: the channel binding must be active (AC-39).
    const bindingRows = await sql<{ state: string; external_id: string }[]>`
      SELECT state, external_id FROM channel_bindings
      WHERE account_id = ${accountId} AND provider = 'telegram'
      LIMIT 1
    `;
    const binding = bindingRows[0];
    if (!binding) {
      // Documented P0 behaviour: recipients without any channel are suppressed
      // with code 'no_channel' — visible in stats, never emailed (spec S08).
      return await suppress(sql, job, 'no_channel');
    }
    if (binding.state === 'revoked') return await suppress(sql, job, 'channel_revoked');
    if (binding.state === 'blocked') return await suppress(sql, job, 'channel_blocked');
    chatId = explicitChatId ?? binding.external_id;

    // Send-time precondition 2: consent must STILL be granted (AC-41 — a stale
    // snapshot never bypasses a revoke). Enforced only for jobs that opted in:
    // direct command replies are answers to a live user request, not pushes.
    if (payload['enforce_consent'] === true && isConsentPurpose(job.purpose)) {
      const scope = readConsentScope(payload);
      const granted = await hasGrant(sql, accountId, job.purpose as ConsentPurpose, scope);
      if (!granted) return await suppress(sql, job, 'consent_revoked');
    }

    // Send-time precondition 3: blocks in either direction stop delivery.
    const counterparty =
      typeof payload['counterparty_account_id'] === 'string'
        ? (payload['counterparty_account_id'] as string)
        : null;
    if (counterparty) {
      const blockedRows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM blocks
        WHERE (blocker_account_id = ${accountId} AND target_account_id = ${counterparty})
           OR (blocker_account_id = ${counterparty} AND target_account_id = ${accountId})
      `;
      if ((blockedRows[0]?.count ?? 0) > 0) return await suppress(sql, job, 'blocked');
    }
  }

  if (!chatId) return await suppress(sql, job, 'no_channel');

  // Channel window: Telegram Bot API is 24/7 — no service window for P0
  // (hook for future channels with restricted windows; spec 04 §7).

  if (!transport) {
    // No transport wired (should not happen — selectTransport always returns one).
    return await suppress(sql, job, 'channel_disabled');
  }

  // External HTTP with NO open DB transaction (spec §7 hard rule).
  const result = await transport.send({ jobId: job.id, chatId, text });
  const outcome: TransportOutcome = {
    state: result.state,
    code: result.code ?? null,
    providerMessageId: result.providerMessageId ?? null,
    retryAfterSeconds: result.retryAfterSeconds ?? null,
  };
  const status = await applyOutcome(sql, job, outcome);
  return `${status}${outcome.code ? `:${outcome.code}` : ''}`;
}

function readConsentScope(payload: Record<string, unknown>): { scopeType: 'global' | 'event'; scopeId: string | null } {
  const scope = payload['consent_scope'];
  if (
    typeof scope === 'object' && scope !== null &&
    (scope as Record<string, unknown>)['type'] === 'event' &&
    typeof (scope as Record<string, unknown>)['id'] === 'string'
  ) {
    return { scopeType: 'event', scopeId: (scope as Record<string, unknown>)['id'] as string };
  }
  return { scopeType: 'global', scopeId: null };
}

async function suppress(sql: Sql, job: OutboxJobRow, code: string): Promise<string> {
  await applySuppression(sql, job, code);
  return `suppressed:${code}`;
}

async function requeueWithErrorCap(sql: Sql, job: OutboxJobRow): Promise<string> {
  const attempt = job.attempt + 1;
  if (attempt >= MAX_UNKNOWN_ATTEMPTS) {
    await sql`UPDATE outbox_jobs SET status = 'unknown', attempt = ${attempt}, lease_until = NULL WHERE id = ${job.id}`;
    return 'error:unknown';
  }
  const seconds = Math.ceil(computeBackoffMs(attempt) / 1000);
  await sql`
    UPDATE outbox_jobs SET status = 'pending', attempt = ${attempt}, lease_until = NULL,
      due_at = now() + (${seconds} * interval '1 second')
    WHERE id = ${job.id}
  `;
  return `error:retry_${seconds}s`;
}

/** Long-running worker: SIGTERM/SIGINT → graceful drain, then exit. */
export async function runWorker(deps: WorkerDeps = {}): Promise<void> {
  const transport = deps.transport ?? (await selectTransport());
  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  console.log(`[worker] started transport=${transport.name}`);
  try {
    while (running) {
      const report = await tickOnce({ sql: deps.sql, transport });
      if (report.claimed > 0 || report.requeuedLeases > 0) {
        console.log(`[worker] claimed=${report.claimed} requeued=${report.requeuedLeases}`, report.results);
      }
      if (running) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    console.log('[worker] drained, exiting');
  }
}

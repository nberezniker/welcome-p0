import type { Sql, TransactionSql } from 'postgres';
import { getSql } from '../lib/db';

/**
 * Outbox pattern (spec 04_ARCHITECTURE §7): business transactions enqueue jobs
 * in the SAME transaction; a worker leases them with FOR UPDATE SKIP LOCKED and
 * executes the external transport OUTSIDE any DB transaction. Every try is
 * recorded in delivery_attempts (redacted — no message payload).
 *
 * Statuses (CHECK in migration 001):
 *   pending → leased → sent | failed | suppressed
 *                     ├─→ pending (retry: 429 / lease expiry / unknown under cap)
 *                     └─→ unknown (terminal after MAX_UNKNOWN_ATTEMPTS — never infinite resend, AC-42)
 */

export type OutboxStatus =
  | 'pending'
  | 'leased'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'unknown'
  | 'suppressed'
  | 'cancelled';

export const OUTBOX_STATUSES: readonly OutboxStatus[] = [
  'pending',
  'leased',
  'sent',
  'delivered',
  'failed',
  'unknown',
  'suppressed',
  'cancelled',
];

/** Outbound message kinds the worker knows how to render. 'telegram_update' is
 * inbound processing and is handled by the worker's update handler. */
export type OutboxKind =
  | 'telegram_update'
  | 'intro_requested_notice'
  | 'intro_mutual_notice'
  | 'campaign_message'
  | 'telegram_reply';

export interface OutboxJobInput {
  dedupeKey: string;
  kind: OutboxKind;
  subjectId: string | null;
  channel: string | null;
  purpose: string;
  /** Recipient account id — REQUIRED for outbound notification jobs so that
   * consent withdrawal / /stop can find and suppress them. Inbound processing
   * jobs deliberately carry none. */
  payload: Record<string, unknown>;
  dueAt?: Date;
}

export interface OutboxJobRow {
  id: string;
  dedupe_key: string;
  kind: string;
  subject_id: string | null;
  channel: string | null;
  purpose: string;
  payload: Record<string, unknown>;
  due_at: Date;
  status: OutboxStatus;
  lease_until: Date | null;
  attempt: number;
  created_at: Date;
}

type SqlLike = Sql | TransactionSql;
type JsonParam = Parameters<Sql['json']>[0];

/**
 * Enqueues one outbox job inside the caller's transaction. dedupe_key is
 * UNIQUE: a duplicate enqueue returns the EXISTING job id and reports
 * created=false — the caller must not repeat the business action (AC-32/37).
 */
export async function enqueueOutbox(
  tx: SqlLike,
  input: OutboxJobInput,
): Promise<{ id: string; created: boolean }> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO outbox_jobs (dedupe_key, kind, subject_id, channel, purpose, payload, due_at)
    VALUES (${input.dedupeKey}, ${input.kind}, ${input.subjectId}, ${input.channel}, ${input.purpose},
            ${tx.json(input.payload as JsonParam)}, ${input.dueAt ?? new Date()})
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `;
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM outbox_jobs WHERE dedupe_key = ${input.dedupeKey} LIMIT 1
  `;
  if (!existing[0]) throw new Error('outbox enqueue: insert conflicted but row not found');
  return { id: existing[0].id, created: false };
}

/**
 * Leases up to `limit` due pending jobs. Short transaction, SKIP LOCKED:
 * concurrent workers never grab the same job. Lease is refreshed by lease_until;
 * a crashed worker's lease expires and the job is re-queued with attempt++.
 */
export async function claimJobs(sql: Sql, limit = 10): Promise<OutboxJobRow[]> {
  return sql.begin(async (tx) => {
    const claimed = await tx<OutboxJobRow[]>`
      UPDATE outbox_jobs
      SET status = 'leased', lease_until = now() + interval '60 seconds'
      WHERE id IN (
        SELECT id FROM outbox_jobs
        WHERE status = 'pending' AND due_at <= now()
        ORDER BY due_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, dedupe_key, kind, subject_id, channel, purpose, payload, due_at, status, lease_until, attempt, created_at
    `;
    return claimed;
  });
}

/** Backoff for attempt n (1-based): n² * 5s + jitter (0..2.5s). Pure; `random` injectable for tests. */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, attempt);
  return n * n * 5000 + Math.floor(random() * 2500);
}

/** Records one delivery try. Redacted: state/code only, never the message payload. */
export async function recordAttempt(
  tx: SqlLike,
  jobId: string,
  state: string,
  code: string | null,
  providerMessageId: string | null,
): Promise<void> {
  await tx`
    INSERT INTO delivery_attempts (job_id, provider_message_id, state, code)
    VALUES (${jobId}, ${providerMessageId}, ${state}, ${code})
  `;
}

export interface TransportOutcome {
  state: 'sent' | 'failed' | 'unknown';
  code: string | null;
  providerMessageId: string | null;
  retryAfterSeconds: number | null;
}

/** Terminal cap for 'unknown' outcomes (transport timeout, no response): after
 * MAX_UNKNOWN_ATTEMPTS tries the job stays 'unknown' forever (AC-42). */
export const MAX_UNKNOWN_ATTEMPTS = 3;

/**
 * Applies a transport outcome to a leased job in a short transaction.
 *  - sent        → status 'sent' (provider acceptance; NEVER 'delivered' — AC/S08)
 *  - 429 (code 'rate_limited') → attempt++, due_at = now + max(Retry-After, backoff) (AC-43)
 *  - failed      → status 'failed', no retry (permanent 4xx)
 *  - unknown     → attempt++, retry with backoff until MAX_UNKNOWN_ATTEMPTS, then terminal 'unknown'
 */
export async function applyOutcome(sql: Sql, job: OutboxJobRow, outcome: TransportOutcome): Promise<OutboxStatus> {
  const attempt = job.attempt + 1;
  return sql.begin(async (tx) => {
    // Guard: only the current lease holder finalizes the job.
    const locked = await tx<OutboxJobRow[]>`
      SELECT id, status FROM outbox_jobs WHERE id = ${job.id} FOR UPDATE
    `;
    if (!locked[0] || locked[0].status !== 'leased') return locked[0]?.status as OutboxStatus ?? 'cancelled';

    if (outcome.state === 'sent') {
      await recordAttempt(tx, job.id, 'sent', outcome.code, outcome.providerMessageId);
      await tx`
        UPDATE outbox_jobs SET status = 'sent', attempt = ${attempt}, lease_until = NULL WHERE id = ${job.id}
      `;
      await bumpCampaignSentCount(tx, job);
      return 'sent';
    }

    if (outcome.state === 'failed') {
      await recordAttempt(tx, job.id, 'failed', outcome.code, null);
      await tx`
        UPDATE outbox_jobs SET status = 'failed', attempt = ${attempt}, lease_until = NULL WHERE id = ${job.id}
      `;
      return 'failed';
    }

    // unknown
    await recordAttempt(tx, job.id, outcome.code === 'rate_limited' ? 'rate_limited' : 'unknown', outcome.code, null);
    if (outcome.code === 'rate_limited') {
      // 429: nothing was sent. Retry after the provider's Retry-When window
      // (at least our own backoff). No hard cap — backoff grows quadratically.
      const backoffMs = Math.max(outcome.retryAfterSeconds ? outcome.retryAfterSeconds * 1000 : 0, computeBackoffMs(attempt));
      await tx`
        UPDATE outbox_jobs
        SET status = 'pending', attempt = ${attempt}, lease_until = NULL,
            due_at = now() + (${Math.ceil(backoffMs / 1000)} * interval '1 second')
        WHERE id = ${job.id}
      `;
      return 'pending';
    }
    if (attempt >= MAX_UNKNOWN_ATTEMPTS) {
      await tx`
        UPDATE outbox_jobs SET status = 'unknown', attempt = ${attempt}, lease_until = NULL WHERE id = ${job.id}
      `;
      return 'unknown';
    }
    await tx`
      UPDATE outbox_jobs
      SET status = 'pending', attempt = ${attempt}, lease_until = NULL,
          due_at = now() + (${Math.ceil(computeBackoffMs(attempt) / 1000)} * interval '1 second')
      WHERE id = ${job.id}
    `;
    return 'pending';
  });
}

/** Marks a suppression outcome (precondition failed at send time). */
export async function applySuppression(sql: Sql, job: OutboxJobRow, code: string): Promise<OutboxStatus> {
  return sql.begin(async (tx) => {
    const locked = await tx<OutboxJobRow[]>`
      SELECT id, status FROM outbox_jobs WHERE id = ${job.id} FOR UPDATE
    `;
    if (!locked[0] || locked[0].status !== 'leased') return locked[0]?.status as OutboxStatus ?? 'cancelled';
    await recordAttempt(tx, job.id, 'suppressed', code, null);
    await tx`
      UPDATE outbox_jobs SET status = 'suppressed', attempt = ${job.attempt + 1}, lease_until = NULL WHERE id = ${job.id}
    `;
    return 'suppressed';
  });
}

/** Increments campaigns.sent_count when a campaign job is accepted by the provider. */
async function bumpCampaignSentCount(tx: SqlLike, job: OutboxJobRow): Promise<void> {
  const campaignId = job.payload['campaign_id'];
  if (job.kind !== 'campaign_message' || typeof campaignId !== 'string') return;
  await tx`
    UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ${campaignId}
  `;
}

/**
 * Re-queues leased jobs whose lease expired (worker crash). attempt++ keeps the
 * try count honest; jobs already at the unknown cap go terminal 'unknown'
 * instead of looping forever.
 */
export async function requeueExpiredLeases(sql: Sql): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE outbox_jobs
    SET status = CASE WHEN attempt + 1 >= ${MAX_UNKNOWN_ATTEMPTS} THEN 'unknown' ELSE 'pending' END,
        attempt = attempt + 1,
        lease_until = NULL,
        due_at = CASE WHEN attempt + 1 >= ${MAX_UNKNOWN_ATTEMPTS} THEN due_at
                      ELSE now() + (${Math.ceil(computeBackoffMs(2) / 1000)} * interval '1 second') END
    WHERE status = 'leased' AND lease_until < now()
    RETURNING id
  `;
  return rows.length;
}

/**
 * Consent withdrawal hook (AC-25): suppress every queued job for this account
 * and purpose that has not been handed to a transport yet. Returns suppressed ids.
 */
export async function suppressJobsForAccountPurpose(
  sql: SqlLike,
  accountId: string,
  purpose: string,
): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    UPDATE outbox_jobs
    SET status = 'suppressed', lease_until = NULL
    WHERE status IN ('pending', 'leased')
      AND purpose = ${purpose}
      AND payload->>'account_id' = ${accountId}
    RETURNING id
  `;
  return rows.map((r) => r.id);
}

/** /stop (AC-39): the channel is gone — cancel everything not yet sent on it. */
export async function suppressJobsForAccountChannel(
  sqlLike: SqlLike,
  accountId: string,
  channel: string,
  code: string,
): Promise<string[]> {
  const rows = await sqlLike<{ id: string }[]>`
    UPDATE outbox_jobs
    SET status = 'suppressed', lease_until = NULL
    WHERE status IN ('pending', 'leased')
      AND channel = ${channel}
      AND payload->>'account_id' = ${accountId}
    RETURNING id
  `;
  for (const r of rows) {
    await recordAttempt(sqlLike, r.id, 'suppressed', code, null);
  }
  return rows.map((r) => r.id);
}

/** Live per-status counters for one campaign's jobs (stats endpoint). */
export async function campaignJobStats(
  sql: Sql,
  campaignId: string,
): Promise<{ status: OutboxStatus; count: number }[]> {
  const rows = await sql<{ status: OutboxStatus; count: number }[]>`
    SELECT status, count(*)::int AS count
    FROM outbox_jobs
    WHERE kind = 'campaign_message' AND payload->>'campaign_id' = ${campaignId}
    GROUP BY status
  `;
  return rows;
}

/** Shared pool access for scripts that don't have one yet. */
export function outboxSql(): Sql {
  return getSql();
}

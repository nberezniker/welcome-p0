import type { Sql, TransactionSql } from 'postgres';
import { getSql } from '../lib/db';
import { currentRequestId } from '../lib/request-context';
import { completeCampaignIfDrained, completeCampaignsIfDrained } from '../domain/campaigns';

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
 *   Inbound jobs (kind 'telegram_update') have no transport step: once their
 *   handler succeeded the lease closes at terminal 'delivered'
 *   (applyUpdateProcessed) — an expired lease must never re-claim them.
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
  | 'intro_declined_notice'
  | 'intro_withdrawn_notice'
  | 'campaign_message'
  | 'telegram_reply'
  /** Phase 4: «next step» reminder (service message about the recipient's own
   *  commitment, purpose `service_channel`). */
  | 'followup_reminder'
  /** Phase 4: weekly «who to meet» digest (purpose `digest_weekly`). */
  | 'digest_weekly';

/** Kinds that only exist while their Phase-4 flag is on. The worker re-checks the
 * flag at SEND time too, so turning a flag off stops queued jobs as well — a kill
 * switch that leaves yesterday's queue running is not a kill switch. */
export const FLAGGED_KINDS: readonly OutboxKind[] = ['followup_reminder', 'digest_weekly'];

export function isFlaggedKind(kind: string): kind is 'followup_reminder' | 'digest_weekly' {
  return (FLAGGED_KINDS as readonly string[]).includes(kind);
}

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
  /** The id of the HTTP request that enqueued this job, or null for a job the
   * WORKER enqueued itself (migration 015). It is what joins a delivery failure
   * back to a request a user can name: `SELECT … WHERE correlation_id = '<id>'`. */
  correlation_id: string | null;
}

type SqlLike = Sql | TransactionSql;
type JsonParam = Parameters<Sql['json']>[0];

/**
 * Enqueues one outbox job inside the caller's transaction. dedupe_key is
 * UNIQUE: a duplicate enqueue returns the EXISTING job id and reports
 * created=false — the caller must not repeat the business action (AC-32/37).
 * due_at defaults to the DB clock (now()) so freshly enqueued jobs are
 * immediately claimable regardless of app/DB clock skew.
 *
 * `correlation_id` is taken from the ambient request context (migration 015) and
 * deliberately NOT a parameter: every call site already runs inside a route's
 * request scope, so reading it here is what keeps the trace honest without
 * asking ~10 business call sites to pass something they would eventually forget.
 * Outside a request — the worker's own follow-up scan — it stays NULL, which is
 * the truthful value: no HTTP request produced that job.
 */
export async function enqueueOutbox(
  tx: SqlLike,
  input: OutboxJobInput,
): Promise<{ id: string; created: boolean }> {
  const correlationId = currentRequestId() ?? null;
  const inserted = input.dueAt
    ? await tx<{ id: string }[]>`
        INSERT INTO outbox_jobs (dedupe_key, kind, subject_id, channel, purpose, payload, due_at, correlation_id)
        VALUES (${input.dedupeKey}, ${input.kind}, ${input.subjectId}, ${input.channel}, ${input.purpose},
                ${tx.json(input.payload as JsonParam)}, ${input.dueAt}, ${correlationId})
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id
      `
    : await tx<{ id: string }[]>`
        INSERT INTO outbox_jobs (dedupe_key, kind, subject_id, channel, purpose, payload, correlation_id)
        VALUES (${input.dedupeKey}, ${input.kind}, ${input.subjectId}, ${input.channel}, ${input.purpose},
                ${tx.json(input.payload as JsonParam)}, ${correlationId})
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
      RETURNING id, dedupe_key, kind, subject_id, channel, purpose, payload, due_at, status, lease_until, attempt, created_at, correlation_id
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
      // F-07 minimization: the message text (may contain names/links) is no
      // longer needed once the provider accepted the job — drop it from the
      // durable payload. campaign_id stays (stats + counters use it).
      await tx`
        UPDATE outbox_jobs SET status = 'sent', attempt = ${attempt}, lease_until = NULL,
          payload = payload - 'text'
        WHERE id = ${job.id}
      `;
      await bumpCampaignSentCount(tx, job);
      // The message was the last thing this recipient was waiting for. Checked in
      // the SAME transaction as the terminal status, so a campaign can never be
      // observed as running while every recipient has already finished.
      await completeCampaignForJob(tx, job);
      return 'sent';
    }

    if (outcome.state === 'failed') {
      await recordAttempt(tx, job.id, 'failed', outcome.code, null);
      await tx`
        UPDATE outbox_jobs SET status = 'failed', attempt = ${attempt}, lease_until = NULL WHERE id = ${job.id}
      `;
      // A permanent rejection is a terminal outcome for this recipient too: a
      // campaign completes on a failure, not only on a success.
      await completeCampaignForJob(tx, job);
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
      // 'unknown' at the cap is terminal (AC-42 give-up): this recipient is
      // finished, and the campaign may be too.
      await completeCampaignForJob(tx, job);
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
    // Suppressed is terminal: the recipient will never be tried again, so a
    // campaign whose last outstanding job was suppressed is finished.
    await completeCampaignForJob(tx, job);
    return 'suppressed';
  });
}

/**
 * Terminal transition for successfully processed inbound jobs
 * (kind 'telegram_update'): the worker handles the update synchronously with
 * no transport round-trip, so 'delivered' closes the lease. Without it the row
 * stayed 'leased' and churned — every lease expiry re-queued it for
 * reprocessing. Same shape as the other finalizers: one short transaction
 * records the try (state 'processed', code = handler outcome) and flips the
 * status, guarded so only the current lease holder finalizes.
 */
export async function applyUpdateProcessed(sql: Sql, job: OutboxJobRow, outcome: string): Promise<OutboxStatus> {
  return sql.begin(async (tx) => {
    const locked = await tx<OutboxJobRow[]>`
      SELECT id, status FROM outbox_jobs WHERE id = ${job.id} FOR UPDATE
    `;
    if (!locked[0] || locked[0].status !== 'leased') return locked[0]?.status as OutboxStatus ?? 'cancelled';
    await recordAttempt(tx, job.id, 'processed', outcome, null);
    await tx`
      UPDATE outbox_jobs SET status = 'delivered', attempt = ${job.attempt + 1}, lease_until = NULL WHERE id = ${job.id}
    `;
    return 'delivered';
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
 * The campaign a job belongs to, when it belongs to one. Every finalizer below
 * uses this to answer "was that the last recipient?" without inventing a second
 * way to find the link — `payload->>'campaign_id'` is the same key
 * `campaignJobStats` and `bumpCampaignSentCount` already read.
 */
function campaignIdOf(job: OutboxJobRow): string | null {
  const campaignId = job.payload['campaign_id'];
  return job.kind === 'campaign_message' && typeof campaignId === 'string' ? campaignId : null;
}

/** Completes the job's campaign when this job was the last recipient pending. */
async function completeCampaignForJob(tx: SqlLike, job: OutboxJobRow): Promise<void> {
  const campaignId = campaignIdOf(job);
  if (campaignId === null) return;
  await completeCampaignIfDrained(tx, campaignId);
}

/** Same, for a set-based update that returned many rows (bulk suppression, leases). */
async function completeCampaignsForJobs(tx: SqlLike, jobs: readonly OutboxJobRow[]): Promise<void> {
  const ids = jobs.map(campaignIdOf).filter((id): id is string => id !== null);
  if (ids.length === 0) return;
  await completeCampaignsIfDrained(tx, ids);
}

/**
 * Re-queues leased jobs whose lease expired (worker crash). attempt++ keeps the
 * try count honest; jobs already at the unknown cap go terminal 'unknown'
 * instead of looping forever.
 */
export async function requeueExpiredLeases(sql: Sql): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx<OutboxJobRow[]>`
      UPDATE outbox_jobs
      SET status = CASE WHEN attempt + 1 >= ${MAX_UNKNOWN_ATTEMPTS} THEN 'unknown' ELSE 'pending' END,
          attempt = attempt + 1,
          lease_until = NULL,
          due_at = CASE WHEN attempt + 1 >= ${MAX_UNKNOWN_ATTEMPTS} THEN due_at
                        ELSE now() + (${Math.ceil(computeBackoffMs(2) / 1000)} * interval '1 second') END
      WHERE status = 'leased' AND lease_until < now()
      RETURNING *
    `;
    // A lease that expired AT the cap goes terminal 'unknown' here, i.e. this
    // sweep can finish a campaign whose worker died before it could — the
    // recipient is given up on, which is a terminal outcome like any other. Rows
    // re-queued to 'pending' leave the campaign running, correctly. Both are
    // covered because the check reads the current statuses rather than assuming
    // which branch each row took.
    await completeCampaignsForJobs(tx, rows);
    return rows.length;
  });
}

/**
 * Releases leases this worker took for jobs it never attempted.
 *
 * WHY THIS EXISTS. A shutdown signal can arrive between claiming a batch and
 * sending the messages in it. Finishing the whole batch would mean the drain
 * lasts `batch × per-call timeout` (10 jobs × 10s = 100s worst case), and any
 * supervisor with a shorter grace period — Docker's default is 10 seconds —
 * would SIGKILL long before the drain finished, turning a tidy shutdown into
 * abandoned leases. Releasing the UNATTEMPTED ones keeps the drain bounded by the
 * one call that is actually in flight, and the jobs are immediately claimable
 * again.
 *
 * `attempt` is deliberately NOT incremented, and `due_at` is left alone: nothing
 * was delivered and nothing was attempted, so this is not a try and not a
 * failure. Incrementing would burn the retry budget on work that never happened
 * (and, at MAX_UNKNOWN_ATTEMPTS, would push a job terminal for a signal we sent
 * ourselves). Only rows this worker still holds — `status = 'leased'` — are
 * touched, so a job another process already finalised is left as it is.
 */
export async function releaseUnattemptedJobs(sql: Sql, jobIds: readonly string[]): Promise<number> {
  if (jobIds.length === 0) return 0;
  const rows = await sql<{ id: string }[]>`
    UPDATE outbox_jobs
    SET status = 'pending', lease_until = NULL
    WHERE id IN ${sql(jobIds)} AND status = 'leased'
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
  const rows = await sql<OutboxJobRow[]>`
    UPDATE outbox_jobs
    SET status = 'suppressed', lease_until = NULL
    WHERE status IN ('pending', 'leased')
      AND purpose = ${purpose}
      AND payload->>'account_id' = ${accountId}
    RETURNING *
  `;
  // A withdrawal that suppresses the last outstanding recipient of a campaign
  // ends that campaign, exactly like a send or a failure would: the recipient
  // will never be tried again. The hook runs in the caller's transaction
  // (consent revocation), so the suppression and the campaign's completion are
  // one commit.
  await completeCampaignsForJobs(sql, rows);
  return rows.map((r) => r.id);
}

/** /stop (AC-39): the channel is gone — cancel everything not yet sent on it. */
export async function suppressJobsForAccountChannel(
  sqlLike: SqlLike,
  accountId: string,
  channel: string,
  code: string,
): Promise<string[]> {
  const rows = await sqlLike<OutboxJobRow[]>`
    UPDATE outbox_jobs
    SET status = 'suppressed', lease_until = NULL
    WHERE status IN ('pending', 'leased')
      AND channel = ${channel}
      AND payload->>'account_id' = ${accountId}
    RETURNING *
  `;
  for (const r of rows) {
    await recordAttempt(sqlLike, r.id, 'suppressed', code, null);
  }
  await completeCampaignsForJobs(sqlLike, rows);
  return rows.map((r) => r.id);
}

/**
 * Phase 4 opt-out: cancels this account's not-yet-sent jobs of SPECIFIC KINDS.
 *
 * Narrower than suppressJobsForAccountPurpose on purpose. A reminder opt-out
 * cannot use the purpose hook: reminders share `service_channel` with the
 * introduction notices, so revoking that purpose would silently also kill
 * "someone asked to connect with you" — a message the user never asked to stop.
 * This is the same mechanism as the two hooks above (same terminal status, same
 * delivery_attempts row, same "only pending/leased" scope), scoped by the one
 * field that actually identifies the mechanic.
 */
export async function suppressJobsForAccountKinds(
  sqlLike: SqlLike,
  accountId: string,
  kinds: readonly OutboxKind[],
  code: string,
): Promise<string[]> {
  if (kinds.length === 0) return [];
  const rows = await sqlLike<OutboxJobRow[]>`
    UPDATE outbox_jobs
    SET status = 'suppressed', lease_until = NULL
    WHERE status IN ('pending', 'leased')
      AND kind IN ${sqlLike(kinds)}
      AND payload->>'account_id' = ${accountId}
    RETURNING *
  `;
  for (const r of rows) {
    await recordAttempt(sqlLike, r.id, 'suppressed', code, null);
  }
  await completeCampaignsForJobs(sqlLike, rows);
  return rows.map((r) => r.id);
}

/**
 * Cancels a campaign's QUEUE: suppresses every one of its messages that has not
 * been handed to a channel yet, and leaves the rest alone.
 *
 * This is the mechanical half of the organizer's stop button. The same scope the
 * other suppression hooks use — `pending` (queued or waiting to retry) and
 * `leased` (claimed) — restricted to this campaign's own jobs by the
 * `payload->>'campaign_id'` key the stats and the counters already read, so a
 * cancel cannot touch a reminder, an introduction notice or another campaign.
 *
 * NOT "NOTHING WAS SENT": a `leased` job may already be inside a transport call,
 * and nothing here can recall a message the channel has accepted. Suppression is
 * the honest instrument — the job will not be attempted again, and the reason is
 * recorded as a delivery_attempts row (code, never the message body) — while
 * `sent`/`delivered`/`failed`/`unknown` rows are terminal and are deliberately
 * left exactly as they are.
 *
 * WHY IT DOES NOT CALL `completeCampaignsIfDrained`. The caller sets the campaign
 * to `cancelled` in the same transaction; completion is a `running`-only
 * transition, so running it here would race the transition it is meant to report
 * (and could write `completed` over a campaign being cancelled). Left to the
 * caller, which owns both statements and their order.
 */
export async function suppressJobsForCampaign(
  sqlLike: SqlLike,
  campaignId: string,
  code: string,
): Promise<string[]> {
  const rows = await sqlLike<OutboxJobRow[]>`
    UPDATE outbox_jobs
    SET status = 'suppressed', lease_until = NULL
    WHERE status IN ('pending', 'leased')
      AND kind = 'campaign_message'
      AND payload->>'campaign_id' = ${campaignId}
    RETURNING *
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

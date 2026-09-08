import type { Sql } from 'postgres';
import { getSql } from '../lib/db';

/**
 * Retention & minimization cleanup pass (F-06) + PII payload minimization (F-07).
 *
 * Properties:
 *   - idempotent: every statement is a time/window filter — running it twice
 *     in a row is a no-op the second time;
 *   - batched: each table is drained in LIMIT-sized batches with an iteration
 *     guard so one pass cannot run away;
 *   - due-gated: runCleanupIfDue() claims a 6-hour slot atomically in
 *     worker_heartbeat.last_cleanup_at, so multiple serverless invocations
 *     never clean concurrently.
 *
 * Retention windows (spec S08 / audit F-06):
 *   sessions            expires_at < now                     (auth safety)
 *   auth_otp_codes      created_at < now() - 1 day
 *   link_challenges     expires_at < now() - 30 days
 *   outbox_jobs         terminal status, created_at < now() - 90 days
 *                       (delivery_attempts cascade with the job)
 *   inbox_events        received_at < now() - 90 days
 *   registrations       claim_state='unclaimed' for events with
 *                       ends_at < now() - 30 days (unactivated imports)
 *   accounts            status='deleting' + updated_at < now() - 7 days →
 *                       purge user rows (sessions, channel_bindings,
 *                       link_challenges, profiles → cascades contact_fields/
 *                       memberships/notes/introductions), reset the
 *                       registration claim link, NULL audit_events actor;
 *                       consent_events are KEPT (scope record) — the
 *                       pseudonymous accounts shell stays so their FK holds.
 */

const BATCH = 500;
const MAX_BATCHES_PER_TABLE = 200; // 200 × 500 = 100k rows per table per pass
const PURGE_BATCH = 50;

export const CLEANUP_MIN_INTERVAL_HOURS = 6;

const OTP_RETENTION_DAYS = 1;
const CHALLENGE_RETENTION_DAYS = 30;
const QUEUE_RETENTION_DAYS = 90;
const REGISTRATION_GRACE_DAYS = 30;
const PURGE_GRACE_DAYS = 7;

const TERMINAL_OUTBOX_STATUSES = ['sent', 'delivered', 'failed', 'unknown', 'suppressed', 'cancelled'] as const;

export interface CleanupReport {
  sessions: number;
  otp_codes: number;
  link_challenges: number;
  outbox_jobs: number;
  inbox_events: number;
  registrations_unclaimed: number;
  accounts_purged: number;
}

/** Runs one full cleanup pass. Exported for tests and manual admin runs. */
export async function runCleanupPass(deps: { sql?: Sql } = {}): Promise<CleanupReport> {
  const sql = deps.sql ?? getSql();

  const report: CleanupReport = {
    sessions: 0,
    otp_codes: 0,
    link_challenges: 0,
    outbox_jobs: 0,
    inbox_events: 0,
    registrations_unclaimed: 0,
    accounts_purged: 0,
  };

  // 1. Expired sessions.
  report.sessions += await drainBatches(async () => {
    const rows = await sql<{ id: string }[]>`
      DELETE FROM sessions
      WHERE id IN (
        SELECT id FROM sessions WHERE expires_at < now() LIMIT ${BATCH}
      )
      RETURNING id
    `;
    return rows.length;
  });

  // 2. OTP codes older than the retention window (used or not).
  report.otp_codes += await drainBatches(async () => {
    const rows = await sql<{ id: string }[]>`
      DELETE FROM auth_otp_codes
      WHERE id IN (
        SELECT id FROM auth_otp_codes
        WHERE created_at < now() - (${OTP_RETENTION_DAYS} * interval '1 day')
        LIMIT ${BATCH}
      )
      RETURNING id
    `;
    return rows.length;
  });

  // 3. Link challenges expired long ago (telegram_link + registration_claim).
  report.link_challenges += await drainBatches(async () => {
    const rows = await sql<{ id: string }[]>`
      DELETE FROM link_challenges
      WHERE id IN (
        SELECT id FROM link_challenges
        WHERE expires_at < now() - (${CHALLENGE_RETENTION_DAYS} * interval '1 day')
        LIMIT ${BATCH}
      )
      RETURNING id
    `;
    return rows.length;
  });

  // 4. Terminal outbox jobs past the queue retention (attempts cascade).
  report.outbox_jobs += await drainBatches(async () => {
    const rows = await sql<{ id: string }[]>`
      DELETE FROM outbox_jobs
      WHERE id IN (
        SELECT id FROM outbox_jobs
        WHERE status = ANY(${TERMINAL_OUTBOX_STATUSES as readonly string[]})
          AND created_at < now() - (${QUEUE_RETENTION_DAYS} * interval '1 day')
        LIMIT ${BATCH}
      )
      RETURNING id
    `;
    return rows.length;
  });

  // 5. Inbox events past the queue retention (minimal payloads already
  //    stripped of text/chat_id by F-07 minimization at processing time).
  report.inbox_events += await drainBatches(async () => {
    const rows = await sql<{ id: number }[]>`
      DELETE FROM inbox_events
      WHERE id IN (
        SELECT id FROM inbox_events
        WHERE received_at < now() - (${QUEUE_RETENTION_DAYS} * interval '1 day')
        LIMIT ${BATCH}
      )
      RETURNING id
    `;
    return rows.length;
  });

  // 6. Unclaimed registrations for events that ended > 30 days ago — the
  //    import was never activated. CLAIMED registrations belong to the
  //    organizer's audience record and are kept.
  report.registrations_unclaimed += await drainBatches(async () => {
    const rows = await sql<{ id: string }[]>`
      DELETE FROM registrations
      WHERE id IN (
        SELECT r.id FROM registrations r
        JOIN events e ON e.id = r.event_id
        WHERE r.claim_state = 'unclaimed'
          AND e.ends_at IS NOT NULL
          AND e.ends_at < now() - (${REGISTRATION_GRACE_DAYS} * interval '1 day')
        LIMIT ${BATCH}
      )
      RETURNING id
    `;
    return rows.length;
  });

  // 7. Purge accounts whose soft delete is older than the grace window.
  report.accounts_purged += await purgeDeletingAccounts(sql);

  return report;
}

/**
 * F-06 due gate: atomically claims the cleanup slot for the next
 * CLEANUP_MIN_INTERVAL_HOURS. Returns null when not due (or the heartbeat row
 * does not exist yet — tickOnce upserts it before calling this).
 */
export async function runCleanupIfDue(deps: { sql?: Sql } = {}): Promise<CleanupReport | null> {
  const sql = deps.sql ?? getSql();
  const claimed = await sql<{ last_cleanup_at: Date | null }[]>`
    UPDATE worker_heartbeat
    SET last_cleanup_at = now()
    WHERE id = true
      AND (last_cleanup_at IS NULL
           OR last_cleanup_at < now() - (${CLEANUP_MIN_INTERVAL_HOURS} * interval '1 hour'))
    RETURNING last_cleanup_at
  `;
  if (!claimed[0]) return null;
  return runCleanupPass({ sql });
}

/** Repeats a batched delete until the table section is drained (bounded). */
async function drainBatches(batch: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_TABLE; i++) {
    const n = await batch();
    total += n;
    if (n < BATCH) break;
  }
  return total;
}

/**
 * Physical purge of fully-deleted accounts (GDPR erasure, F-05/F-06):
 *  - audit_events.actor_account_id → NULL (pseudonymized, audit trail kept);
 *  - the registration claim link is reset (registrations themselves are the
 *    organizer's data and stay);
 *  - sessions, channel_bindings, link_challenges, profiles are deleted
 *    (profiles cascade: contact_fields, memberships, notes, introduction
 *    consents and the introductions the account was party to);
 *  - consent_events are KEPT with their scope — legal record; the FK target
 *    (pseudonymous accounts shell, auth_subject='deleted:<uuid>') remains.
 * updated_at is bumped so the shell is not re-processed every pass.
 */
async function purgeDeletingAccounts(sql: Sql): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM accounts
    WHERE status = 'deleting'
      AND updated_at < now() - (${PURGE_GRACE_DAYS} * interval '1 day')
    LIMIT ${PURGE_BATCH}
  `;
  let purged = 0;
  for (const account of rows) {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE audit_events SET actor_account_id = NULL WHERE actor_account_id = ${account.id}
      `;
      // Reset the claim link; the registration row (organizer's data) stays.
      await tx`
        UPDATE registrations SET claim_state = 'unclaimed'
        WHERE claim_state = 'claimed'
          AND id IN (
            SELECT m.registration_id FROM event_memberships m
            JOIN profiles p ON p.id = m.profile_id
            WHERE p.account_id = ${account.id} AND m.registration_id IS NOT NULL
          )
      `;
      await tx`DELETE FROM sessions WHERE account_id = ${account.id}`;
      await tx`DELETE FROM channel_bindings WHERE account_id = ${account.id}`;
      await tx`DELETE FROM link_challenges WHERE account_id = ${account.id}`;
      await tx`DELETE FROM profiles WHERE account_id = ${account.id}`;
      await tx`
        UPDATE accounts SET updated_at = now() WHERE id = ${account.id}
      `;
    });
    purged += 1;
  }
  return purged;
}

// ---------------------------------------------------------------------------
// F-07: payload minimization.
// ---------------------------------------------------------------------------

/**
 * Strips conversation PII from a processed inbox event. After a
 * telegram_update job was handled successfully, only the routing-neutral
 * facts remain (update_id, message_id — event_type lives in its own column,
 * received_at is the timestamp); chat_id/from_id/text are removed. The chat
 * identity survives in channel_bindings where it belongs.
 */
export async function minimizeTelegramInboxPayload(sql: Sql, inboxEventId: number): Promise<boolean> {
  const rows = await sql<{ id: number }[]>`
    UPDATE inbox_events
    SET minimal_payload = minimal_payload - 'text' - 'chat_id' - 'from_id'
    WHERE id = ${inboxEventId} AND provider = 'telegram'
    RETURNING id
  `;
  return rows.length > 0;
}

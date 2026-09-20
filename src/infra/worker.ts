import type { Sql } from 'postgres';
import { getSql } from '../lib/db';
import { hasGrant, isConsentPurpose, type ConsentPurpose } from '../domain/consent';
import {
  applyOutcome,
  applySuppression,
  applyUpdateProcessed,
  claimJobs,
  computeBackoffMs,
  isFlaggedKind,
  MAX_UNKNOWN_ATTEMPTS,
  releaseUnattemptedJobs,
  requeueExpiredLeases,
  type OutboxJobRow,
  type TransportOutcome,
} from './outbox';
import { handleTelegramUpdate, type TelegramUpdatePayload } from './telegram-handlers';
import { minimizeTelegramInboxPayload, runCleanupIfDue, type CleanupReport } from './cleanup';
import { selectTransport } from '../integrations/telegram';
import type { ChannelTransport } from '../integrations/telegram/transport';
import {
  selectNotificationEmailTransport,
  type EmailTransport,
} from '../integrations/email';
import { appBaseUrl } from '../lib/env';
import { log } from '../lib/logger';
import { DEFAULT_LOCALE } from '../i18n/locale';
import {
  campaignEmailSubject,
  isServiceNoticeKind,
  serviceNoticeEmail,
} from '../domain/service-notices';
import { decideRecipientChannel, loadTelegramBindingState, resolveAccountEmail } from './recipient-channel';
import { runFollowupScan, type FollowupScanReport } from './followup-scan';
import { loadOptInState } from './followup-preferences';
import { reminderSubject } from '../domain/followup';
import { digestSubject } from '../domain/digest';
import { digestEnabled, followupRemindersEnabled } from '../lib/env';

/**
 * Outbox worker (spec 04 §7). tickOnce() is exported for tests — no
 * long-running loop in CI. Per claimed job the worker:
 *   1. re-checks send-time preconditions (binding active, no block, current
 *      consent, channel reachability) and marks violations 'suppressed'
 *      (completing the AC-25 hook end-to-end);
 *   2. executes the transport OUTSIDE any DB transaction;
 *   3. records the outcome + a delivery_attempts row in a short transaction.
 * Inbound jobs (kind 'telegram_update') have no transport step: once the
 * handler succeeded they go terminal 'delivered' (applyUpdateProcessed) —
 * an expired lease must never re-claim a processed update.
 * After the job batch, the retention/minimization cleanup pass runs when due
 * (F-06/F-07 — at most once per CLEANUP_MIN_INTERVAL_HOURS).
 */

export interface WorkerDeps {
  sql?: Sql;
  transport?: ChannelTransport;
  /** Email transport for outbound jobs routed to the email channel (ADR 0011).
   * Omitted → `selectNotificationEmailTransport()` (Resend when configured, else
   * null → the job is suppressed with `channel_disabled`). */
  emailTransport?: EmailTransport | null;
  /** Test hook: set false to skip the cleanup due-gate. */
  cleanup?: boolean;
  /** Max jobs claimed by this tick (default BATCH_LIMIT). Callers that must stay
   * short — the webhook post-response fast path — pass a small cap instead of
   * getting their own copy of the claim/process logic. */
  batchLimit?: number;
  /** Set false to skip the Phase-4 follow-up scan. The webhook fast path does:
   * it exists to answer one user in seconds, and a scan belongs on the scheduled
   * tick, not in front of an interactive reply. Omitted → the scan runs (and
   * returns immediately while its flags are off). */
  followupScan?: boolean;
  /** Where a job-level processing failure is reported. See JobErrorReporter. */
  reportJobError?: JobErrorReporter;
  /**
   * Asked before each claimed job: "should this tick stop claiming further work?"
   * Set by `runWorker` to read its shutdown flag, so a SIGTERM releases the
   * claimed-but-unattempted remainder of the batch instead of sending it (see
   * releaseUnattemptedJobs). Left undefined — the HTTP tick and every test — the
   * batch is always processed in full, which is the behaviour everywhere except a
   * process that has been asked to stop.
   */
  shouldStop?: () => boolean;
}

/**
 * How a job that threw while being processed is reported.
 *
 * The default is the loud, production behaviour: an error log carrying the job
 * id/kind and the error with its stack. It is injectable ONLY so a test that
 * breaks a transport on purpose can declare the failure it is asserting and
 * keep the expected stack trace out of the gate output — the error is still
 * reported, just to that recorder. Nothing in production sets it, and no other
 * test does either, so every genuinely unexpected error stays exactly as loud as
 * before. This is deliberately a seam, not a log-level switch: a level would
 * silence unexpected errors too.
 */
export type JobErrorReporter = (job: OutboxJobRow, err: unknown) => void;

const reportJobErrorToConsole: JobErrorReporter = (job, err) => {
  // The job id and kind are opaque identifiers, not content: they are what the
  // runbook needs to find the row. Nothing from the payload is logged — for an
  // outbound job that payload is the message, recipient included.
  //
  // `correlation_id` is the id of the HTTP REQUEST that enqueued the job
  // (migration 015), so this line joins the delivery failure to the request that
  // caused it: the same value the caller received in an error body or response
  // header. NULL for worker-enqueued jobs, and then the field is simply absent.
  log.error('[worker] job failed', {
    event: 'job_failed',
    job_id: job.id,
    job_kind: job.kind,
    correlation_id: job.correlation_id ?? undefined,
    err,
  });
};

export interface TickReport {
  heartbeat: boolean;
  requeuedLeases: number;
  claimed: number;
  /** Jobs whose lease this tick released WITHOUT attempting them, because a
   *  shutdown was requested after they had been claimed (see
   *  releaseUnattemptedJobs). Non-zero only during a drain. */
  released: number;
  /** `correlation_id` is the enqueuing request, when there was one — see
   *  `reportJobErrorToConsole`. It is carried here so the tick summary can name
   *  the request behind a job that did not succeed. */
  results: { job_id: string; kind: string; outcome: string; correlation_id: string | null }[];
  /** F-06: retention pass result — null when not due this tick. */
  cleanup: CleanupReport | null;
  /** Phase 4: what the follow-up scan did this tick. Both mechanics report
   *  `enabled: false` (and nothing is queried) while their flag is off. */
  followup: FollowupScanReport;
}

const BATCH_LIMIT = 10;

/** Report shape for a tick that deliberately skipped the follow-up scan (the
 * webhook fast path). `enabled: false` is the honest reading: that tick did not
 * look, so it cannot claim the mechanics are off. */
const SKIPPED_FOLLOWUP_SCAN: FollowupScanReport = {
  enabled: { reminders: false, digest: false },
  reminders: { scanned: 0, enqueued: 0 },
  digest: { scanned: 0, enqueued: 0 },
  error: null,
};

/** Transports resolved for one tick: telegram (injected or default) + email. */
interface TickTransports {
  telegram: ChannelTransport | null;
  email: EmailTransport | null;
}

/** One worker tick: heartbeat → requeue expired leases → follow-up scan →
 * claim → process → cleanup pass when due (F-06). The claim batch is
 * overridable via deps.batchLimit — the webhook post-response path
 * (infra/post-response-tick) reuses this exact tick with a small cap instead of
 * duplicating the pipeline.
 *
 * The Phase-4 follow-up scan runs BEFORE the claim so the jobs it enqueues with
 * `due_at = now()` are picked up by this very tick. It returns immediately —
 * without a single query — while both flags are off (phase 4 §1). */
export async function tickOnce(deps: WorkerDeps = {}): Promise<TickReport> {
  const sql = deps.sql ?? getSql();
  const reportJobError = deps.reportJobError ?? reportJobErrorToConsole;
  const transports: TickTransports = {
    telegram: deps.transport ?? null,
    // Resolved per tick (not at module load) so env changes stay observable, and
    // so a deployment without a provider suppresses honestly instead of logging.
    email: 'emailTransport' in deps ? deps.emailTransport ?? null : selectNotificationEmailTransport(),
  };

  // Liveness (worker_heartbeat, id=true) — written on every tick, and this is
  // the signal GET /api/health measures against its freshness window
  // (WORKER_FRESHNESS_SECONDS; src/lib/env.ts argues both the default and why the
  // window has to follow the deployment's cadence, not a fixed minute).
  await sql`
    INSERT INTO worker_heartbeat (id, beat_at) VALUES (true, now())
    ON CONFLICT (id) DO UPDATE SET beat_at = now()
  `;
  const requeuedLeases = await requeueExpiredLeases(sql);

  // Phase 4: called unconditionally unless the caller opts out; the flags are
  // checked INSIDE (and only there) so the "off means no scan" rule has exactly
  // one implementation.
  const followup = deps.followupScan === false ? SKIPPED_FOLLOWUP_SCAN : await runFollowupScan(sql);

  const jobs = await claimJobs(sql, deps.batchLimit ?? BATCH_LIMIT);
  const results: TickReport['results'] = [];
  let released = 0;
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i]!;
    // Checked BEFORE the job is attempted, so a signal that arrived while the
    // previous job was in flight releases the untouched remainder instead of
    // sending it. The job already in flight is never cut off — it finishes and
    // is finalised, which is what makes the drain graceful rather than abortive.
    if (deps.shouldStop?.()) {
      const leftover = jobs.slice(i).map((j) => j.id);
      released = await releaseUnattemptedJobs(sql, leftover);
      if (released > 0) {
        log.info('[worker] shutdown requested — released claimed jobs without attempting them', {
          event: 'worker_released_unattempted',
          count: released,
        });
      }
      break;
    }
    const outcome = await processJob(sql, transports, job, reportJobError);
    results.push({ job_id: job.id, kind: job.kind, outcome, correlation_id: job.correlation_id });
  }

  // F-06: retention + minimization, due-gated (>= 6h between runs), after the
  // job batch so a busy tick is never delayed by housekeeping.
  const cleanup = deps.cleanup === false ? null : await runCleanupIfDue({ sql });

  return { heartbeat: true, requeuedLeases, claimed: jobs.length, released, results, cleanup, followup };
}

async function processJob(
  sql: Sql,
  transports: TickTransports,
  job: OutboxJobRow,
  reportJobError: JobErrorReporter,
): Promise<string> {
  try {
    if (job.kind === 'telegram_update') {
      const outcome = await handleTelegramUpdate(sql, job.payload as unknown as TelegramUpdatePayload);
      // F-07: the update was processed — strip conversation PII from the
      // durable inbox row (chat_id lives in channel_bindings, not here).
      const inboxEventId = job.payload['inbox_event_id'];
      if (typeof inboxEventId === 'number' || typeof inboxEventId === 'string') {
        await minimizeTelegramInboxPayload(sql, Number(inboxEventId));
      }
      // Lease-churn fix: a processed update is terminal 'delivered' — without
      // this the leased row survived the tick and was re-claimed (reprocessed)
      // on every lease expiry. Deliberately the LAST step: if minimization
      // throws, the job is still leased and the catch below requeues it; once
      // delivered, nothing in this branch can throw.
      await applyUpdateProcessed(sql, job, outcome);
      return `processed:${outcome}`;
    }
    return await processOutbound(sql, transports, job);
  } catch (err) {
    // Unexpected processing error (not a transport outcome): requeue with
    // backoff, respecting the unknown cap so a poison job cannot loop forever.
    reportJobError(job, err);
    return await requeueWithErrorCap(sql, job);
  }
}

/**
 * Outbound message job: channel selection → preconditions → transport → outcome.
 *
 * Channel selection (ADR 0011) happens here, on live state, in the same spirit as
 * the other send-time preconditions: an active Telegram binding wins, otherwise a
 * decryptable account email takes over when the job's own consent holds, and a
 * revoked/blocked binding stays terminal (a "stop" is never re-routed).
 */
async function processOutbound(sql: Sql, transports: TickTransports, job: OutboxJobRow): Promise<string> {
  const payload = job.payload;
  const text = typeof payload['text'] === 'string' ? payload['text'] : null;
  if (!text) return await suppress(sql, job, 'bad_payload');

  const accountId = typeof payload['account_id'] === 'string' ? (payload['account_id'] as string) : null;
  const explicitChatId = typeof payload['chat_id'] === 'string' ? (payload['chat_id'] as string) : null;

  // Jobs without a recipient account (inbound-driven command replies) are
  // addressed by an explicit chat id only — unchanged Telegram behaviour.
  if (!accountId) {
    if (!explicitChatId) return await suppress(sql, job, 'no_channel');
    return await sendTelegram(sql, transports.telegram, job, explicitChatId, text);
  }

  // Phase 4 kill switches, re-checked at SEND time. A flag that only stops NEW
  // enqueues would leave yesterday's queue delivering, and an opt-in that only
  // gates the scan would send a digest the recipient has already stopped — both
  // reasons are recorded as their own suppression codes so the delivery_attempts
  // trail says which gate closed.
  if (isFlaggedKind(job.kind)) {
    const enabled = job.kind === 'followup_reminder' ? followupRemindersEnabled() : digestEnabled();
    if (!enabled) return await suppress(sql, job, 'feature_disabled');
    if (!(await mechanicOptedIn(sql, accountId, job.kind))) {
      return await suppress(sql, job, 'opt_in_withdrawn');
    }
  }

  const enforceConsent = payload['enforce_consent'] === true && isConsentPurpose(job.purpose);
  const scope = readConsentScope(payload);

  const binding = await loadTelegramBindingState(sql, accountId);
  let consentGranted: boolean | null = null;
  let hasEmail = false;

  if (binding?.state === 'active') {
    // Consent must STILL be granted (AC-41 — a stale snapshot never bypasses a
    // revoke). Enforced only for jobs that opted in: direct command replies are
    // answers to a live user request, not pushes.
    if (enforceConsent) {
      consentGranted = await hasGrant(sql, accountId, job.purpose as ConsentPurpose, scope);
    }
  } else if (!binding) {
    // No binding at all: the email channel is the one candidate, so the address
    // lookup happens before the consent check (a recipient with no channel and
    // no address keeps the historical `no_channel` code, not `consent_revoked`).
    const eventId = typeof payload['event_id'] === 'string' ? (payload['event_id'] as string) : null;
    hasEmail = (await resolveAccountEmail(sql, accountId, eventId)) !== null;
    if (hasEmail && enforceConsent) {
      consentGranted = await hasGrant(sql, accountId, job.purpose as ConsentPurpose, scope);
    }
  }

  const decision = decideRecipientChannel({
    telegramBinding: binding?.state ?? null,
    hasEmail,
    consentGranted,
  });
  if (decision.channel === 'suppress') return await suppress(sql, job, decision.code);

  // Send-time precondition 3: blocks in either direction stop delivery on ANY channel.
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

  // Channel window: Telegram Bot API is 24/7 — no service window for P0
  // (hook for future channels with restricted windows; spec 04 §7).
  if (decision.channel === 'email') return await sendEmailWithJobText(sql, transports.email, job);

  const chatId = explicitChatId ?? binding!.externalId;
  return await sendTelegram(sql, transports.telegram, job, chatId, text);
}

/** Telegram dispatch: one HTTP call outside any transaction, then the outcome. */
async function sendTelegram(
  sql: Sql,
  transport: ChannelTransport | null,
  job: OutboxJobRow,
  chatId: string,
  text: string,
): Promise<string> {
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

/**
 * Email dispatch (ADR 0011). The body is rendered from the job KIND, never from
 * the stored payload text — except for `campaign_message`, whose body IS the
 * organizer's approved `body_text`, sent verbatim as on the Telegram channel.
 * The recipient address is resolved here and handed straight to the transport;
 * it is never written to the job, the attempt row or any log line.
 */
async function sendEmailWithJobText(
  sql: Sql,
  transport: EmailTransport | null,
  job: OutboxJobRow,
): Promise<string> {
  const accountId = job.payload['account_id'] as string;
  const eventId = typeof job.payload['event_id'] === 'string' ? (job.payload['event_id'] as string) : null;
  const to = await resolveAccountEmail(sql, accountId, eventId);
  if (!to) return await suppress(sql, job, 'no_channel');

  let subject: string;
  let body: string;
  if (job.kind === 'campaign_message') {
    subject = campaignEmailSubject(DEFAULT_LOCALE);
    body = typeof job.payload['text'] === 'string' ? (job.payload['text'] as string) : '';
  } else if (isFlaggedKind(job.kind)) {
    // Phase 4: the body of a reminder/digest is rendered at enqueue time by a
    // PURE renderer whose input type is the whitelist (the recipient's own step
    // text / goal, directory-visible names, the frozen v4 reasons) — there is no
    // field through which a contact value or another person's private data could
    // reach it, which is what lets the email channel carry the same body the
    // Telegram channel sends instead of a second, thinner copy.
    subject = job.kind === 'followup_reminder' ? reminderSubject(DEFAULT_LOCALE) : digestSubject(DEFAULT_LOCALE);
    body = typeof job.payload['text'] === 'string' ? (job.payload['text'] as string) : '';
  } else if (isServiceNoticeKind(job.kind)) {
    // EN: the worker does not read accounts.locale (migration 014). The column
    // is the durable UI preference; honouring it for outbound mail is a separate
    // change — a recorded known gap (src/i18n/README.md), not an oversight.
    const rendered = serviceNoticeEmail(job.kind, appBaseUrl(), DEFAULT_LOCALE);
    subject = rendered.subject;
    body = rendered.text;
  } else {
    // A kind with no email rendering must never be guessed at.
    return await suppress(sql, job, 'bad_payload');
  }
  if (body.length === 0) return await suppress(sql, job, 'bad_payload');

  if (!transport) return await suppress(sql, job, 'channel_disabled');

  const result = await transport.send({ to, subject, text: body });
  const outcome: TransportOutcome = {
    state: result.state,
    code: result.code ?? null,
    providerMessageId: result.providerMessageId ?? null,
    retryAfterSeconds: result.retryAfterSeconds ?? null,
  };
  const status = await applyOutcome(sql, job, outcome);
  return `${status}:email${outcome.code ? `:${outcome.code}` : ''}`;
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

/**
 * Send-time opt-in check for the two Phase-4 kinds. The scan already gated on it,
 * but an opt-out that lands between enqueue and send must stop the message — and
 * the opt-out endpoint suppresses queued jobs too, so this is the second of the
 * two independent guarantees (defence in depth, same as consent at send time).
 */
async function mechanicOptedIn(sql: Sql, accountId: string, kind: 'followup_reminder' | 'digest_weekly'): Promise<boolean> {
  const state = await loadOptInState(sql, accountId);
  return kind === 'followup_reminder' ? state.reminders : state.digest;
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
  const emailTransport = 'emailTransport' in deps ? deps.emailTransport ?? null : selectNotificationEmailTransport();
  let running = true;
  const stop = (): void => {
    running = false;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  log.info('[worker] started', {
    event: 'worker_started',
    provider: transport.name,
    email_provider: emailTransport?.name ?? 'none',
  });
  try {
    while (running) {
      const report = await tickOnce({
        sql: deps.sql,
        transport,
        emailTransport,
        reportJobError: deps.reportJobError,
        // Read per job, so a signal that lands mid-tick is honoured before the
        // next job in the claimed batch is attempted.
        shouldStop: () => !running,
      });
      if (report.claimed > 0 || report.requeuedLeases > 0) {
        // A summary line plus one line per job that did NOT succeed. The tick used
        // to print `report.results` as an array argument, which is unqueryable (an
        // operator cannot filter "everything that was suppressed" out of a console
        // dump) and puts a success row on every tick — noise that hides the rows
        // worth reading. The full array is unchanged in the tick's JSON response
        // (/api/internal/worker-tick), so nothing is lost for the HTTP path.
        log.info('[worker] tick', {
          event: 'worker_tick',
          count: report.claimed,
          requeued: report.requeuedLeases,
        });
        for (const result of report.results) {
          if (!/^(error|suppressed):/.test(result.outcome)) continue;
          log.warn('[worker] job outcome', {
            event: 'job_outcome',
            job_id: result.job_id,
            job_kind: result.kind,
            outcome: result.outcome,
            correlation_id: result.correlation_id ?? undefined,
          });
        }
      }
      if (running) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    log.info('[worker] drained, exiting', { event: 'worker_drained' });
  }
}

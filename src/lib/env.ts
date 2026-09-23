/** Env access. Values are validated lazily at use sites so the app can boot
 * (and print a clear error) even with an incomplete .env. */

import { parseEmailAllowlist, parseKeyring, type Keyring } from './crypto';
import { log } from './logger';

export type AppEnv = 'development' | 'test' | 'production';

export function appEnv(): AppEnv {
  const v = process.env.APP_ENV;
  if (v === 'production' || v === 'test') return v;
  return 'development';
}

export function isProduction(): boolean {
  return appEnv() === 'production';
}

export function appBaseUrl(): string {
  return process.env.APP_BASE_URL || 'http://localhost:3000';
}

/** APP_BASE_URL without a fallback: '' when unset. For bot copy, where a bare
 * relative path is still readable but a guessed host (localhost / hardcoded
 * deploy URL) would be wrong. */
export function appBaseUrlOrEmpty(): string {
  return process.env.APP_BASE_URL || '';
}

/** Pepper for HMAC-SHA256 email lookup and OTP hashing. Required in every environment. */
export function requireHashPepper(): string {
  const pepper = process.env.HASH_PEPPER;
  if (!pepper || pepper.length < 8) {
    throw new Error('HASH_PEPPER is not configured');
  }
  return pepper;
}

/** Base64 of exactly 32 bytes; AES-256-GCM key for contact values at rest. */
export function requireEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY is not configured');
  }
  return key;
}

/**
 * The keyring every stored secret is sealed and opened with — the active key
 * plus any key this deployment must still be able to READ.
 *
 * THE SAME VARIABLE, WIDENED. `ENCRYPTION_KEY` stays REQUIRED and stays the
 * material of the active key, so a deployment that sets nothing else gets a
 * one-key keyring with id `v1`: the id every existing payload already carries,
 * which is why this replaced no data and needed no migration. The two optional
 * variables add the ability to read MORE than one key, which is what a rotation
 * is made of (src/lib/crypto.ts carries the shapes and the refusals;
 * docs-internal/ops/RUNBOOK.md §5 is the procedure).
 *
 * `requireEncryptionKey()` remains for the one consumer that must NOT follow the
 * keyring: the OAuth `state` MAC derives its key from ENCRYPTION_KEY alone
 * (src/lib/oauth-state.ts), and moving it is a decision with a user-visible
 * 10-minute window, deliberately NOT taken yet — see
 * docs-internal/security/KEY_ROTATION_ASSESSMENT.md § "The OAuth-state MAC".
 *
 * Read lazily at every use site like the other required config, so a
 * misconfigured deployment fails where it is used, naming what is wrong.
 */
export function requireKeyring(): Keyring {
  const parsed = parseKeyring({
    encryptionKey: process.env.ENCRYPTION_KEY,
    encryptionKeys: process.env.ENCRYPTION_KEYS,
    activeKeyId: process.env.ENCRYPTION_KEY_ID,
  });
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }
  return parsed.keyring;
}

/**
 * Operator contact address published on the landing page and the legal pages.
 *
 * Deliberately NOT defaulted to the upstream author's inbox. This repository is
 * public and meant to be self-hosted: a deployment that never configures a
 * contact must publish none, rather than quietly routing a stranger's mail to
 * somebody else's mailbox. Unset → `''` (see SELF_HOSTING.md «Operator contact»).
 */
export function operatorContactEmail(): string {
  return (process.env.OPERATOR_CONTACT_EMAIL ?? '').trim();
}

/**
 * `mailto:` for the pilot CTAs, or `null` when no operator contact is
 * configured — in which case the CTAs are not rendered at all. A pilot button
 * pointing nowhere (or at the upstream author) would be worse than no button.
 */
export function pilotMailto(): string | null {
  const email = operatorContactEmail();
  return email.length > 0 ? `mailto:${email}?subject=WELCOME%20pilot` : null;
}

/**
 * Dev-only helper: expose OTP in the verify response.
 * Only when APP_ENV=development AND AUTH_DEV_EXPOSE_OTP=true. Never in production.
 */
export function devExposeOtp(): boolean {
  return appEnv() === 'development' && process.env.AUTH_DEV_EXPOSE_OTP === 'true';
}

// ---------------------------------------------------------------------------
// ADR 0009 — staging-only dev-OTP allowlist.
//
// A deliberate, narrow alternative to AUTH_DEV_EXPOSE_OTP (which is
// development-only): a staging-test deployment that runs APP_ENV=production
// and has no email provider can expose the OTP for a small, explicit set of
// SYNTHETIC addresses. Two variables, both required:
//   AUTH_EXPOSE_OTP_EMAILS=true            → master switch
//   AUTH_EXPOSE_OTP_EMAIL_ALLOWLIST=a,b,c  → the addresses (CSV)
// The switch alone exposes nothing: an address must also be on the list, and
// the list is matched against the peppered lookup hash (src/lib/crypto.ts),
// never in plaintext. Never enable either variable in a real production
// deployment.
// ---------------------------------------------------------------------------

/** Master switch for the ADR 0009 allowlist. Off unless exactly 'true'. */
export function exposeOtpEmails(): boolean {
  return process.env.AUTH_EXPOSE_OTP_EMAILS === 'true';
}

/** Raw CSV from AUTH_EXPOSE_OTP_EMAIL_ALLOWLIST; '' when unset. Never logged. */
export function allowDevOtpEmailsRaw(): string {
  return process.env.AUTH_EXPOSE_OTP_EMAIL_ALLOWLIST || '';
}

/** The one warning text operators grep for; kept verbatim for runbooks. */
export const OTP_EXPOSURE_WARNING = 'DEV OTP EXPOSURE ENABLED ON PRODUCTION — staging-test only';

/**
 * Pure message builder for the ADR 0009 warning: `null` unless the allowlist
 * is switched on *while running in production*. Deliberately reports only the
 * NUMBER of allowlisted addresses — the addresses themselves never reach logs.
 */
export function otpExposureWarningMessage(
  env: AppEnv,
  flag: boolean,
  allowlistCount: number,
): string | null {
  if (env !== 'production' || !flag) return null;
  return `${OTP_EXPOSURE_WARNING} (${allowlistCount} allowlisted ${allowlistCount === 1 ? 'address' : 'addresses'})`;
}

/**
 * Builds a warning emitter that fires at most once per instance (per module
 * load, i.e. per server process in a serverless deployment). Returned function
 * is a no-op when the message is `null`, and marks itself as warned only when
 * it actually logged — so a warm instance that boots in development and later
 * flips to production (tests, staged rollouts) still warns.
 *
 * The emitter is a parameter (not a hard call to `log.warn`) so that the
 * once-only contract can be asserted without capturing global console state —
 * tests/unit/otp-exposure-warning.test.ts injects a recorder. The DEFAULT is the
 * logger: the message text is unchanged (operators grep for
 * OTP_EXPOSURE_WARNING), and it stays a single `warn` call per process.
 */
export function createOtpExposureWarner(
  emit: (message: string) => void = (message) => log.warn(message, { event: 'otp_exposure_enabled' }),
): (env: AppEnv, flag: boolean, allowlistCount: number) => void {
  let warned = false;
  return (env, flag, allowlistCount) => {
    if (warned) return;
    const message = otpExposureWarningMessage(env, flag, allowlistCount);
    if (!message) return;
    warned = true;
    emit(`[otp-exposure] ${message}`);
  };
}

// ---------------------------------------------------------------------------
// Phase 4 — post-event follow-up mechanics (docs-internal/product/
// SOCIAL_INTEROP_AND_MATCHING.md §B5). Two features that SEND messages, so each
// is a separate kill switch and both default to OFF:
//
//   FOLLOWUP_REMINDERS_ENABLED=true → the «next step» reminder scanner runs;
//   DIGEST_ENABLED=true             → the weekly «who to meet» digest runs.
//
// Absent/unset/any other value means "the feature does not exist": no scan in
// the worker, no job enqueued, no toggle rendered, no endpoint answering. These
// are read lazily at every call site (never captured at module load) so a
// deployment can turn a mechanic off and have the very next tick honour it — and
// so a process that boots without them cannot be talked into sending by a later
// env mutation of another feature.
// ---------------------------------------------------------------------------

/** Master switch for the «next step» reminder. Off unless exactly 'true'. */
export function followupRemindersEnabled(): boolean {
  return process.env.FOLLOWUP_REMINDERS_ENABLED === 'true';
}

/** Master switch for the weekly digest. Off unless exactly 'true'. */
export function digestEnabled(): boolean {
  return process.env.DIGEST_ENABLED === 'true';
}

/** Default «what you wanted to do» delay (design §B5 «через N дней»). */
export const FOLLOWUP_REMINDER_DAYS_DEFAULT = 7;

/**
 * Days after a next_step was written before its reminder becomes due.
 * `FOLLOWUP_REMINDER_DAYS` overrides it; an unparsable, fractional, negative or
 * zero value falls back to the default instead of clamping to something that
 * would fire instantly — a bad number must not turn a week into "right now".
 * The upper bound keeps the due-date arithmetic inside a sane range.
 */
export function followupReminderDays(raw: string | undefined = process.env.FOLLOWUP_REMINDER_DAYS): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) return FOLLOWUP_REMINDER_DAYS_DEFAULT;
  return parsed;
}

// ---------------------------------------------------------------------------
// Worker-heartbeat freshness — the window GET /api/health judges `worker` by.
// Read lazily at every call (same reason as the flags above: a deployment can
// change its cadence and have the very next health call honour it).
// ---------------------------------------------------------------------------

/**
 * Default freshness window for the worker heartbeat: 26 hours.
 *
 * WHY 26 HOURS AND NOT A MINUTE. A freshness window is only meaningful relative
 * to the tick CADENCE of the deployment it runs in: a window shorter than one
 * tick period reports a perfectly healthy worker as dead, permanently. This
 * repo's serverless shape has exactly one unconditional tick source — the Vercel
 * cron in `vercel.json` (`17 3 * * *`, daily, because the free plan allows
 * nothing faster) — so the previous 60-second window was measuring a cadence the
 * deployment never had: every uptime monitor got a standing false alarm and an
 * operator looking at the payload could not tell "the scheduler is slow" from
 * "the worker is broken". 24h + 2h absorbs cron dispatch jitter, and it stays
 * below TWO cadences, so it still detects a real stop: a worker that misses a
 * whole day reads `down` about 26h after its last tick, before the next cron
 * would even have fired.
 *
 * The cost is stated plainly rather than hidden: on a daily-cron deployment the
 * boolean cannot be more timely than its cadence. That is what
 * `worker_last_tick_age_seconds` in the same payload is for — a monitor that
 * needs to alert within minutes thresholds the AGE, not the boolean.
 *
 * SELF-HOSTING WITH A DIFFERENT CADENCE: set `WORKER_FRESHNESS_SECONDS` to your
 * own tick period plus slack. `pnpm worker` ticks every 2s (120 is plenty), a
 * per-minute cron wants ~180, the 5-minute GitHub-Actions pinger ~900.
 */
export const WORKER_FRESHNESS_SECONDS_DEFAULT = 24 * 60 * 60 + 2 * 60 * 60;

/** Upper bound on a configured window: 30 days. Shared with `workerFreshnessSeconds`. */
const WORKER_FRESHNESS_SECONDS_MAX = 30 * 24 * 60 * 60;

/**
 * Seconds a beat may age before the worker counts as down.
 * `WORKER_FRESHNESS_SECONDS` overrides the default; anything that is not a whole
 * number of seconds in `[1, 30 days]` falls back to the default instead of
 * clamping. Both bounds exist because a bad number here is not a cosmetic bug:
 *   - zero or negative makes EVERY deployment read `worker: down` forever — the
 *     same class of permanent false alarm this setting exists to end;
 *   - a plausible unit mix-up (`93600000` is 26h expressed in milliseconds,
 *     ~1083 days) would otherwise disable the check for three years, while the
 *     default is exactly the value that mistake was reaching for.
 */
export function workerFreshnessSeconds(raw: string | undefined = process.env.WORKER_FRESHNESS_SECONDS): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > WORKER_FRESHNESS_SECONDS_MAX) {
    return WORKER_FRESHNESS_SECONDS_DEFAULT;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Database statement budget — how long ONE SQL statement may run.
// Read once, when the pool is built (src/lib/db.ts); see the note there.
// ---------------------------------------------------------------------------

/**
 * Default `statement_timeout`: 10 seconds.
 *
 * WHY THIS EXISTS. `connect_timeout` (5s) bounds *reaching* the server, not
 * *running* on it: once a connection is up, a query that is blocked on a lock, a
 * bad plan or a stuck seq scan holds its pooled connection until the client
 * gives up — which, with no bound, is never. Ten pooled connections and one
 * unbounded statement is a request (or a worker tick) pinned indefinitely.
 *
 * WHY 10 SECONDS, specifically:
 *   - it matches the outbound budget this app already uses for a single external
 *     call (REQUEST_TIMEOUT_MS = 10s in the Telegram and email transports), so a
 *     hung statement cannot outlive the send that is waiting on it;
 *   - it is far above every statement this schema actually runs. The heaviest are
 *     the directory/audience joins and the batched cleanup DELETEs (500 rows per
 *     pass) — all indexed, all sized per event or per 500 rows. A statement that
 *     needs seconds here is a bug or a lock, not a workload;
 *   - it is short enough to be a bound. A timeout longer than the caller's own
 *     budget is not a safety control, it is a delayed failure.
 *
 * NOT APPLIED TO MIGRATIONS. `scripts/migrate.mjs` builds its own client, so a
 * long index build in a migration is deliberately outside this budget.
 */
export const STATEMENT_TIMEOUT_MS_DEFAULT = 10_000;

/**
 * Bounds on a configured statement budget, and why there is no "off".
 *
 * `statement_timeout = 0` means DISABLED in Postgres. A configured zero would
 * therefore restore exactly the unbounded behaviour this setting removes, so the
 * accepted range starts at 100ms rather than at 0 — the same stance
 * src/lib/outbound.ts takes for HTTP ("a timeout is a safety control, not a
 * preference"). The floor is also below any real statement, so it cannot be
 * reached by accident.
 *
 * The 10-minute ceiling is a typo guard, not a workload limit: a unit mix-up
 * (`600000` is 10 minutes in ms; `600000000` is 6.9 days) would otherwise turn
 * the bound into decoration while looking like a deliberate number.
 */
export const STATEMENT_TIMEOUT_MS_MIN = 100;
export const STATEMENT_TIMEOUT_MS_MAX = 10 * 60 * 1000;

/**
 * Milliseconds a single SQL statement may run before Postgres cancels it.
 * `STATEMENT_TIMEOUT_MS` overrides the default; anything that is not a whole
 * number of milliseconds in `[100, 600000]` — including `0`, which Postgres
 * would read as "no limit" — falls back to the default instead of clamping.
 */
export function statementTimeoutMs(raw: string | undefined = process.env.STATEMENT_TIMEOUT_MS): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < STATEMENT_TIMEOUT_MS_MIN || parsed > STATEMENT_TIMEOUT_MS_MAX) {
    return STATEMENT_TIMEOUT_MS_DEFAULT;
  }
  return parsed;
}

const defaultExposureWarner = createOtpExposureWarner();

/**
 * Route-level guard for the ADR 0009 allowlist. Reads the current env and the
 * allowlist SIZE (never the addresses) and emits the warning at most once per
 * process. Parameters exist for tests only.
 */
export function warnIfOtpExposureOnProduction(
  env: AppEnv = appEnv(),
  flag: boolean = exposeOtpEmails(),
  allowlistCount: number = parseEmailAllowlist(allowDevOtpEmailsRaw()).length,
): void {
  defaultExposureWarner(env, flag, allowlistCount);
}

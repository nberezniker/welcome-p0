/** Env access. Values are validated lazily at use sites so the app can boot
 * (and print a clear error) even with an incomplete .env. */

import { parseEmailAllowlist } from './crypto';
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

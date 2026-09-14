/** Env access. Values are validated lazily at use sites so the app can boot
 * (and print a clear error) even with an incomplete .env. */

import { parseEmailAllowlist } from './crypto';

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
 */
export function createOtpExposureWarner(
  log: (message: string) => void = (message) => console.warn(message),
): (env: AppEnv, flag: boolean, allowlistCount: number) => void {
  let warned = false;
  return (env, flag, allowlistCount) => {
    if (warned) return;
    const message = otpExposureWarningMessage(env, flag, allowlistCount);
    if (!message) return;
    warned = true;
    log(`[otp-exposure] ${message}`);
  };
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

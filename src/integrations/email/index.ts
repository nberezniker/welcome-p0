import { ResendEmailTransport, type EmailTransport } from './transport';
import { DevOtpLogTransport } from './dev-transport';
import { DisabledEmailTransport } from './disabled-transport';

export type TransportEnv = Record<string, string | undefined>;

function resolveAppEnv(env: TransportEnv): 'development' | 'test' | 'production' {
  if (env.APP_ENV === 'production' || env.APP_ENV === 'test') return env.APP_ENV;
  return 'development';
}

/**
 * Email transport selection matrix (F-01, mirrors the Telegram adapter):
 *   1. RESEND_API_KEY set                → real Resend transport (any env)
 *   2. no key, APP_ENV !== 'production'  → dev transport: OTP lands in the
 *      gitignored `.runtime/otp.log` (development/tests only)
 *   3. otherwise (production without
 *      a key)                            → disabled transport: the OTP route
 *      answers 503 `email_channel_disabled` — an honest explicit failure,
 *      never a silent drop and never the old read-only-FS 500.
 */
export function selectEmailTransport(env: TransportEnv = process.env): EmailTransport {
  const apiKey = env.RESEND_API_KEY;
  if (apiKey && apiKey.length > 0) {
    return new ResendEmailTransport(apiKey, env.RESEND_FROM || 'WELCOME <onboarding@resend.dev>');
  }
  if (resolveAppEnv(env) !== 'production') return new DevOtpLogTransport();
  return new DisabledEmailTransport();
}

/** What the OTP request route should DO with a freshly generated code. */
export type OtpDeliveryPlan =
  /** Return `devCode` in the response (explicitly gated dev/demo branches). */
  | { action: 'expose' }
  /** Hand the code to the selected transport, then answer `{ok:true}`. */
  | { action: 'deliver' }
  /** Explicit failure — production without any email provider. */
  | { action: 'reject'; status: 503; code: 'email_channel_disabled'; retryable: false };

export interface OtpDeliveryInput {
  appEnv: 'development' | 'test' | 'production';
  resendApiKey: string | undefined;
  /** AUTH_DEV_EXPOSE_OTP (existing dev/tests mechanism; dev only). */
  devExposeOtp: boolean;
  /** AUTH_EXPOSE_DEMO_OTP=true (demo fallback, see below). */
  exposeDemoOtp: boolean;
  /** The target account is a synthetic demo account (accounts.is_demo). */
  isDemo: boolean;
  /** AUTH_EXPOSE_OTP_EMAILS=true (staging-only allowlist switch, ADR 0009). */
  exposeOtpEmails: boolean;
  /** The target account's email is on the ADR 0009 allowlist. */
  emailAllowlisted: boolean;
}

/**
 * Pure decision for OTP delivery (F-01). Branch order is deliberate:
 *
 *   1. AUTH_DEV_EXPOSE_OTP — pre-existing dev/tests-only mechanism (devExposeOtp()
 *      already requires APP_ENV !== production).
 *   2. DEMO FALLBACK — explicit, documented branch: when the operator sets
 *      AUTH_EXPOSE_DEMO_OTP=true, accounts flagged is_demo (synthetic seed
 *      accounts whose email addresses are not real) get the code in the
 *      response so the demo login flow works WITHOUT any email provider.
 *      OFF by default; never applies to non-demo accounts, so real users are
 *      unaffected even if the flag is left on by mistake.
 *   3. STAGING ALLOWLIST (ADR 0009) — AUTH_EXPOSE_OTP_EMAILS=true AND the
 *      account's email present in AUTH_EXPOSE_OTP_EMAIL_ALLOWLIST. Same
 *      motivation as the demo branch (works without a provider) but scoped to
 *      a named list of synthetic addresses instead of the is_demo column, so a
 *      staging-test deploy running APP_ENV=production can exercise the real
 *      login flow. OFF by default, and the switch alone exposes nothing: an
 *      address must also match the list.
 *   4. A configured provider → real delivery.
 *   5. No provider outside production → dev log file.
 *   6. No provider in production → explicit reject (the F-01 fix: honest 503
 *      instead of an unconditional dev-log write crashing with 500).
 */
export function planOtpDelivery(input: OtpDeliveryInput): OtpDeliveryPlan {
  if (input.appEnv !== 'production' && input.devExposeOtp) return { action: 'expose' };
  if (input.exposeDemoOtp && input.isDemo) return { action: 'expose' };
  // ADR 0009: both the switch and a list match are required.
  if (input.exposeOtpEmails && input.emailAllowlisted) return { action: 'expose' };
  if (input.resendApiKey && input.resendApiKey.length > 0) return { action: 'deliver' };
  if (input.appEnv !== 'production') return { action: 'deliver' }; // dev log transport
  return { action: 'reject', status: 503, code: 'email_channel_disabled', retryable: false };
}

/** The OTP email is deliberately minimal: one subject, one code, no links. */
export function otpEmailTask(to: string, code: string): { to: string; subject: string; text: string; otpCode: string } {
  return { to, subject: 'WELCOME login code', text: `WELCOME login code: ${code}`, otpCode: code };
}

/**
 * Transport for NOTIFICATION email (outbox jobs, ADR 0011) — deliberately NOT
 * `selectEmailTransport()`:
 *
 *   - the dev transport writes the recipient address into `.runtime/otp.log`;
 *     acceptable for the operator's own OTP, never for a notification that
 *     carries a third party's address;
 *   - the disabled transport maps a send to `failed`, which would push the job
 *     terminal on every tick instead of an honest suppression.
 *
 * Notifications therefore have exactly one real provider and `null` otherwise:
 * the worker suppresses the job with `channel_disabled` when this returns null,
 * so a deployment without an email provider keeps an auditable outcome and never
 * a fallback that logs an address.
 */
export function selectNotificationEmailTransport(env: TransportEnv = process.env): EmailTransport | null {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || apiKey.length === 0) return null;
  return new ResendEmailTransport(apiKey, env.RESEND_FROM || 'WELCOME <onboarding@resend.dev>');
}

export { ResendEmailTransport } from './transport';
export { DevOtpLogTransport } from './dev-transport';
export { DisabledEmailTransport } from './disabled-transport';
export type { EmailTransport, EmailSendResult, EmailSendTask } from './transport';

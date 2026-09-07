/** Env access. Values are validated lazily at use sites so the app can boot
 * (and print a clear error) even with an incomplete .env. */

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

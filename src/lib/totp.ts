import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * F-03: TOTP (RFC 6238) + recovery codes for MFA. Pure node:crypto — no new
 * dependencies. Secrets are generated/verified here and stored encrypted
 * (AES-256-GCM, src/lib/crypto.ts); recovery codes are stored only as
 * SHA-256 hashes.
 */

export type TotpAlgorithm = 'sha1' | 'sha256';

export interface TotpOptions {
  algorithm?: TotpAlgorithm;
  digits?: number;
  /** Seconds per step (RFC default 30). */
  period?: number;
}

const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 (no padding) — the format authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += RFC4648_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += RFC4648_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Inverse of base32Encode; throws on characters outside the alphabet. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[=\s]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = RFC4648_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160-bit TOTP shared secret, base32-encoded (20 bytes is the RFC 4226 recommendation). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Unix step counter for a point in time. */
function counterAt(timeMs: number, period: number): number {
  return Math.floor(timeMs / 1000 / period);
}

/** HOTP dynamic truncation (RFC 4226 §5.3) over the HMAC of the counter. */
function hotpAt(secret: Buffer, counter: number, algorithm: TotpAlgorithm, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, secret).update(buf).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** TOTP code valid at `timeMs` (defaults to now). Used by tests and dev tooling. */
export function totpAt(secretBase32: string, timeMs: number = Date.now(), opts: TotpOptions = {}): string {
  const { algorithm = 'sha1', digits = 6, period = 30 } = opts;
  return hotpAt(base32Decode(secretBase32), counterAt(timeMs, period), algorithm, digits);
}

/**
 * Verifies a user-supplied TOTP code with a ±`window` step skew (default ±1,
 * i.e. ±30 s at period 30). Every candidate step is compared so the response
 * time does not leak which step matched; comparisons are constant-time.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  timeMs: number = Date.now(),
  opts: TotpOptions & { window?: number } = {},
): boolean {
  const { algorithm = 'sha1', digits = 6, period = 30, window = 1 } = opts;
  const normalized = code.trim();
  if (new RegExp(`^\\d{${digits}}$`).test(normalized) === false) return false;
  const secret = base32Decode(secretBase32);
  const counter = counterAt(timeMs, period);
  // Evaluate ALL candidates, keep the match flag — no early exit (timing).
  let matched = false;
  const supplied = Buffer.from(normalized, 'utf8');
  for (let skew = -window; skew <= window; skew++) {
    const expected = Buffer.from(hotpAt(secret, counter + skew, algorithm, digits), 'utf8');
    if (timingSafeEqual(supplied, expected)) matched = true;
  }
  return matched;
}

/** otpauth URI for authenticator apps (spec F-03 format, SHA1/6 digits/30 s). */
export function otpauthUri(email: string, secretBase32: string, issuer = 'WELCOME'): string {
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}` +
    `?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  );
}

// ---------------------------------------------------------------------------
// Recovery codes: shown once at enroll, stored only as SHA-256 hashes.
// ---------------------------------------------------------------------------

/** Number of recovery codes issued per enrollment. */
export const RECOVERY_CODES_COUNT = 8;

/** Normalizes user input: `welc-9k2m`, `WELC 9K2M` and `WELC9K2M` are the same code. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** SHA-256 hex of the normalized code — the only persisted form. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code), 'utf8').digest('hex');
}

/** Generates `count` codes shaped `XXXX-XXXX` from the base32 alphabet (40 bits each). */
export function generateRecoveryCodes(count: number = RECOVERY_CODES_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(8);
    let s = '';
    for (const byte of raw) s += RFC4648_ALPHABET[byte & 31];
    codes.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return codes;
}

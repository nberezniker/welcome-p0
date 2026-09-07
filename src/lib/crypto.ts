import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256 hex digest — base primitive for peppered lookups and OTP hashing. */
export function hmacHex(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value, 'utf8').digest('hex');
}

/** Hash of the OTP code. Only the hash is stored in auth_otp_codes.code_hash. */
export function hashOtpCode(code: string, pepper: string): string {
  return hmacHex(code, pepper);
}

/** Email lookup key: HMAC-SHA256(email, HASH_PEPPER). Raw email is never stored in the DB. */
export function emailLookupHash(email: string, pepper: string): string {
  return hmacHex(email.trim().toLowerCase(), pepper);
}

/** Session / link tokens: only SHA-256 hash is persisted; the raw token lives in the cookie. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cryptographically random 6-digit OTP, zero-padded. */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 256-bit session token, base64url-encoded. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Public profile slug: base64url of 16 random bytes → 22 chars, 128-bit entropy.
 * Generated once, never changes; satisfies profiles CHECK (char_length >= 22).
 */
export function generatePublicSlug(): string {
  return randomBytes(16).toString('base64url');
}

/** Constant-time comparison of two hex strings. */
export function timingSafeHexEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Decodes the base64 ENCRYPTION_KEY env value; must be exactly 32 bytes (AES-256). */
export function decodeEncryptionKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)');
  }
  return key;
}

const VALUE_PREFIX = 'v1';

/**
 * AES-256-GCM encryption for contact_fields.encrypted_value.
 * Format: "v1.<iv b64>.<ciphertext b64>.<auth tag b64>" — random 12-byte IV per value.
 */
export function encryptValue(plaintext: string, keyBase64: string): string {
  const key = decodeEncryptionKey(keyBase64);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VALUE_PREFIX}.${iv.toString('base64')}.${ciphertext.toString('base64')}.${tag.toString('base64')}`;
}

/** Decrypts an AES-256-GCM payload produced by encryptValue. Throws on tampering. */
export function decryptValue(payload: string, keyBase64: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VALUE_PREFIX) {
    throw new Error('encrypted value format is invalid');
  }
  const ivB64 = parts[1];
  const ctB64 = parts[2];
  const tagB64 = parts[3];
  if (!ivB64 || !ctB64 || !tagB64) throw new Error('encrypted value format is invalid');
  const key = decodeEncryptionKey(keyBase64);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

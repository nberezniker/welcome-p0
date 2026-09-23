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

/**
 * Parses a comma-separated allowlist of email addresses (ADR 0009): trims,
 * lowercases and drops empty entries, de-duplicating while preserving order.
 * The raw env value never leaves this function as anything but normalized
 * addresses — and callers must never log them (see otpExposureWarningMessage).
 */
export function parseEmailAllowlist(rawList: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of rawList.split(',')) {
    const value = part.trim().toLowerCase();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Constant-time membership test for the staging-only dev-OTP allowlist
 * (ADR 0009). The caller passes the account's ALREADY HASHED lookup hash, so
 * the raw target email and the raw list entries never meet: every candidate is
 * normalized + HMAC'd with the same pepper and compared to the same digest.
 * The whole list is always scanned — there is no early exit that would leak
 * whether (or where) a match occurred.
 */
export function isEmailAllowlisted(lookupHash: string, rawList: string, pepper: string): boolean {
  let matched = false;
  for (const candidate of parseEmailAllowlist(rawList)) {
    if (timingSafeHexEqual(lookupHash, emailLookupHash(candidate, pepper))) matched = true;
  }
  return matched;
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

/**
 * Constant-time comparison of two secrets (webhook tokens). Both sides are
 * SHA-256 hashed first so the comparison never leaks length or prefix bytes.
 */
export function secureSecretEqual(provided: string, expected: string): boolean {
  return timingSafeHexEqual(hashSessionToken(provided), hashSessionToken(expected));
}

/** Decodes the base64 ENCRYPTION_KEY env value; must be exactly 32 bytes (AES-256). */
export function decodeEncryptionKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)');
  }
  return key;
}

// ---------------------------------------------------------------------------
// THE KEYRING
//
// WHY THIS EXISTS. One AES-256-GCM key, and every secret at rest is sealed with
// it: contact values, imported registrant emails, TOTP secrets, OAuth code
// verifiers and Google grant tokens (src/lib/key-rotation.ts is the registry of
// the six columns). As long as exactly one key can ever have been used, losing
// it loses that data and leaking it has no remedy — and the payload could not
// even say which key it meant, so nothing could be re-encrypted. That is the
// limitation this removes.
//
// THE FORMAT DID NOT CHANGE. Today's payload is
//   v1.<iv b64>.<ciphertext b64>.<tag b64>
// and `v1` was a version slot that had to equal one hard-coded constant. `v1` IS
// a key id: the same slot now means "the key with this id sealed me", and the
// id `v1` is the one every existing payload already carries. So there is no
// migration, no second parser and no dual-format reader — the slot is READ
// instead of compared, and the legacy id is simply the first entry in the
// keyring.
//
// WHAT A KEYRING IS HERE. A deployment can hold several keys: exactly one is
// ACTIVE (what new writes use) and every id present can be READ. That is enough
// for a rotation to be a series of ordinary states rather than a single atomic
// act: read old while writing new, backfill, then retire the old key
// (docs-internal/security/KEY_ROTATION_ASSESSMENT.md, §d).
//
// THE ONE RULE THAT MAKES IT SAFE. A payload whose id is not in the keyring is a
// hard error that NAMES the id. There is no fallback to the active key: a
// fallback would turn "this deployment is missing a key" — a mistake an operator
// can fix by restoring the env — into data that decrypts to garbage, or into a
// 500 with no clue which key is missing.
// ---------------------------------------------------------------------------

/**
 * The id the single-key shorthand writes, and the id every payload written
 * before the keyring existed already carries. It is what used to be called the
 * payload's "version".
 */
export const LEGACY_KEY_ID = 'v1';

/**
 * Ids go in the payload's first slot, which is `.`-delimited, so an id may not
 * contain `.` (or whitespace, or anything a shell or an env file might eat).
 * Underscore is deliberately NOT allowed either: the rotation command selects
 * rows with a LIKE pattern, where `_` matches any character, and an id that is
 * also a wildcard is a selection bug waiting to happen.
 */
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface Keyring {
  /** The id NEW payloads are written under. Always present in `keys`. */
  readonly active: string;
  /** id → base64 key material, for READING. Includes the active id. */
  readonly keys: ReadonlyMap<string, string>;
}

export type KeyringParse = { ok: true; keyring: Keyring } | { ok: false; message: string };

function isValidKeyId(id: string): boolean {
  return KEY_ID_PATTERN.test(id);
}

/** One entry of ENCRYPTION_KEYS: `<id>:<base64>`, never echoing key material back. */
function parseKeyringEntry(entry: string, index: number, active: string, keys: Map<string, string>): string | null {
  const colon = entry.indexOf(':');
  if (colon === -1) {
    return `ENCRYPTION_KEYS entry ${index} is not <id>:<base64> (the key material is never echoed here)`;
  }
  const id = entry.slice(0, colon).trim();
  const material = entry.slice(colon + 1).trim();
  if (!isValidKeyId(id)) {
    return `ENCRYPTION_KEYS entry ${index} has an unusable key id (letters, digits and dashes, starting with a letter or digit)`;
  }
  if (id === active) {
    return (
      `ENCRYPTION_KEYS names the active key id ${active}. The active key's material is ENCRYPTION_KEY; ` +
      'naming that id again is exactly the ambiguity this refuses.'
    );
  }
  if (keys.has(id)) {
    return `ENCRYPTION_KEYS names the id ${id} twice — one id must mean exactly one key`;
  }
  const key = Buffer.from(material, 'base64');
  if (key.length !== 32) {
    return `the key for id ${id} in ENCRYPTION_KEYS must decode to exactly 32 bytes (AES-256)`;
  }
  keys.set(id, material);
  return null;
}

/**
 * Builds the keyring from what the environment says. Pure — the caller reads the
 * env (src/lib/env.ts `requireKeyring`), so this is testable without one.
 *
 * THE ENVIRONMENT SHAPE, and why it is this one:
 *   ENCRYPTION_KEY      REQUIRED, unchanged: the material of the ACTIVE key. In a
 *                       deployment with no rotation in flight this is the only
 *                       key there is, and its id is `v1` — which is exactly
 *                       today's behaviour, byte for byte.
 *   ENCRYPTION_KEY_ID   OPTIONAL: the active key's id, default `v1`.
 *   ENCRYPTION_KEYS     OPTIONAL: FURTHER keys this deployment can still READ,
 *                       as `<id>:<base64>` pairs.
 *
 * Two consequences worth stating, because they are the design:
 *   · the active key's material can never be missing — it is ENCRYPTION_KEY, so
 *     "write under an id whose key we do not have" is not expressible;
 *   · a rotation never requires pasting the same secret into two variables: the
 *     key that is being moved away from is parked in ENCRYPTION_KEYS under its
 *     own id while ENCRYPTION_KEY takes the new one.
 * Every misconfiguration that IS expressible is a refusal naming what is wrong,
 * never a silently different keyring.
 */
export function parseKeyring(input: {
  encryptionKey?: string | undefined;
  encryptionKeys?: string | undefined;
  activeKeyId?: string | undefined;
}): KeyringParse {
  const material = (input.encryptionKey ?? '').trim();
  if (material.length === 0) return { ok: false, message: 'ENCRYPTION_KEY is not configured' };

  const active = (input.activeKeyId ?? '').trim() || LEGACY_KEY_ID;
  if (!isValidKeyId(active)) {
    return { ok: false, message: 'ENCRYPTION_KEY_ID is not a usable key id (letters, digits and dashes)' };
  }

  const keys = new Map<string, string>();
  keys.set(active, material);

  const raw = (input.encryptionKeys ?? '').trim();
  if (raw.length > 0) {
    let index = 0;
    for (const part of raw.split(',')) {
      const entry = part.trim();
      if (entry.length === 0) continue; // a trailing comma is a typo, not a key
      index += 1;
      const problem = parseKeyringEntry(entry, index, active, keys);
      if (problem) return { ok: false, message: problem };
    }
  }

  return { ok: true, keyring: { active, keys } };
}

/**
 * The key id a stored payload carries, or `null` when it is not a
 * `<id>.<iv>.<ct>.<tag>` payload at all. Reads the slot only — no key, no
 * decryption — which is what lets the rotation command count a column by key id
 * without holding every key it finds.
 */
export function payloadKeyId(payload: string): string | null {
  const parts = payload.split('.');
  if (parts.length !== 4) return null;
  const [id, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
  if (!id || !ivB64 || !ctB64 || !tagB64) return null;
  return id;
}

/**
 * The single place a payload is written, so the format exists once:
 * `<id>.<iv b64>.<ciphertext b64>.<tag b64>`, random 12-byte IV per value.
 */
function seal(plaintext: string, id: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${id}.${iv.toString('base64')}.${ciphertext.toString('base64')}.${tag.toString('base64')}`;
}

/**
 * The single place a payload is parsed and opened. `keyFor` supplies the key for
 * the id the payload names; KEY SELECTION is therefore the only difference
 * between the legacy single-key reader and the keyring reader, and the parsing,
 * the base64 handling and the AEAD below are the same code for both.
 */
function open(payload: string, keyFor: (id: string) => Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 4) throw new Error('encrypted value format is invalid');
  const [id, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
  if (!ivB64 || !ctB64 || !tagB64) throw new Error('encrypted value format is invalid');
  const key = keyFor(id!);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * AES-256-GCM encryption under ONE explicitly named key, id `v1`.
 *
 * This is the legacy signature and it is deliberately unchanged: the demo seeds,
 * the two-person walkthrough and the usage-matrix sweep all build a payload from
 * a raw env key at the command line, and `v1` is the id such a payload has always
 * carried. Application code goes through `encryptStored` instead, which writes
 * the keyring's ACTIVE id.
 */
export function encryptValue(plaintext: string, keyBase64: string): string {
  return seal(plaintext, LEGACY_KEY_ID, decodeEncryptionKey(keyBase64));
}

/**
 * Decrypts a `v1` payload with ONE explicitly named key. Unchanged behaviour,
 * including its refusals: a payload whose first segment is not `v1` is rejected
 * as invalid rather than attempted under the given key.
 */
export function decryptValue(payload: string, keyBase64: string): string {
  return open(payload, (id) => {
    if (id !== LEGACY_KEY_ID) throw new Error('encrypted value format is invalid');
    return decodeEncryptionKey(keyBase64);
  });
}

/** Seals a value for storage under the keyring's ACTIVE key, naming it in the payload. */
export function encryptStored(plaintext: string, keyring: Keyring): string {
  const material = keyring.keys.get(keyring.active);
  if (material === undefined) {
    // Not reachable through parseKeyring (the active id is always populated) —
    // it is here so a hand-built keyring cannot write a payload with no key.
    throw new Error(`no encryption key with id ${keyring.active} in the keyring`);
  }
  return seal(plaintext, keyring.active, decodeEncryptionKey(material));
}

/**
 * Opens a stored payload by the id it carries, or throws naming the id this
 * deployment cannot supply — NEVER falling back to the active key. A fallback
 * would make a missing key look like corrupt data; the name is what lets an
 * operator put the right key back and read the row again.
 */
export function decryptStored(payload: string, keyring: Keyring): string {
  return open(payload, (id) => {
    const material = keyring.keys.get(id);
    if (material === undefined) {
      throw new Error(`no encryption key with id ${id} in the keyring`);
    }
    return decodeEncryptionKey(material);
  });
}

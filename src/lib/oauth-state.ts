/**
 * Signed, single-use OAuth `state` (project brief: "a signed, single-use state
 * that also records which provider the user is connecting").
 *
 * HOW IT IS BUILT
 *   state = base64url(payload) + "." + base64url(HMAC-SHA256(payload))
 *
 * The MAC key is DERIVED from ENCRYPTION_KEY with HKDF (a different `info`
 * string than any other consumer), so a state cannot be forged without the
 * deployment's own secret and no new environment variable is required. The MAC
 * covers the encoded payload verbatim, so a single flipped character is caught
 * before the JSON is even parsed.
 *
 * WHAT IT CARRIES
 *   - `jti`      — the key of the oauth_flow_states row; the server-side half of
 *                  SINGLE USE (migration 013). A signature proves authenticity
 *                  but not freshness, so the jti is the part that makes a
 *                  replayed callback fail even though its MAC is still valid;
 *   - `accountId`— the account that started the flow. The callback additionally
 *                  requires this to equal the live session, so a state leaked
 *                  from one browser cannot connect a Google account to another;
 *   - `provider` — which of the two providers this consent is for ('google-
 *                  contacts' / 'google-calendar');
 *   - `iat`/`exp`— when it was issued and when it dies (10 minutes).
 *
 * It NEVER carries the PKCE verifier, a token, or anything else secret: those
 * live only in the database (encrypted). The state travels through the user's
 * browser and through Google's redirect, so it must remain useless on its own.
 *
 * The module is pure — key in, decision out — which is what lets the unit suite
 * prove the tampered / replayed / expired cases without a network or a DB.
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { decodeEncryptionKey } from './crypto';
import { GOOGLE_OAUTH_STATE_TTL_SECONDS, isGoogleOAuthProvider, type GoogleOAuthProvider } from '../domain/google-oauth';

/** Payload version, so a future change can be rejected rather than misread. */
export const OAUTH_STATE_VERSION = 1;

export interface OAuthStatePayload {
  v: number;
  /** Flow id — the primary key of the oauth_flow_states row (single use). */
  jti: string;
  /** Account that started the flow. */
  accountId: string;
  provider: GoogleOAuthProvider;
  /** Seconds since epoch. */
  iat: number;
  /** Seconds since epoch. */
  exp: number;
}

export type OAuthStateErrorCode =
  /** Not `<b64>.<b64>`, or the payload is not the shape above. */
  | 'malformed'
  /** Payload parsed but the MAC does not match: tampered or foreign. */
  | 'bad_signature'
  /** Signature fine, window over. */
  | 'expired';

export type OAuthStateVerification =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; code: OAuthStateErrorCode };

/**
 * Derives the MAC key from the deployment's ENCRYPTION_KEY.
 *
 * HKDF rather than "use the AES key bytes directly": the state key and the
 * content-encryption key are different cryptographic roles, and deriving one
 * from the other means a weakness in either does not simply transfer.
 */
export function oauthStateKey(encryptionKeyBase64: string): Buffer {
  const base = decodeEncryptionKey(encryptionKeyBase64);
  return Buffer.from(hkdfSync('sha256', base, 'welcome-oauth-state-salt-v1', 'oauth-state-mac-v1', 32));
}

function mac(key: Buffer, encodedPayload: string): Buffer {
  return createHmac('sha256', key).update(encodedPayload, 'utf8').digest();
}

/** Signs a payload. `now` and `ttlSeconds` are parameters so tests can pin time. */
export function signOAuthState(
  input: { jti: string; accountId: string; provider: GoogleOAuthProvider },
  encryptionKeyBase64: string,
  now: Date = new Date(),
  ttlSeconds: number = GOOGLE_OAUTH_STATE_TTL_SECONDS,
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: OAuthStatePayload = {
    v: OAUTH_STATE_VERSION,
    jti: input.jti,
    accountId: input.accountId,
    provider: input.provider,
    iat,
    exp: iat + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${mac(oauthStateKey(encryptionKeyBase64), encoded).toString('base64url')}`;
}

/**
 * Verifies signature FIRST, then shape, then expiry.
 *
 * Order matters: parsing an unauthenticated payload would mean making decisions
 * on attacker-controlled JSON, so the MAC is checked before a single field is
 * read. The comparison is constant-time (`timingSafeEqual`) and length-checked,
 * so a forged state cannot be narrowed down by timing.
 */
export function verifyOAuthState(
  state: unknown,
  encryptionKeyBase64: string,
  now: Date = new Date(),
): OAuthStateVerification {
  if (typeof state !== 'string' || state.length === 0 || state.length > 4096) {
    return { ok: false, code: 'malformed' };
  }
  const parts = state.split('.');
  if (parts.length !== 2) return { ok: false, code: 'malformed' };
  const [encoded, providedMac] = parts as [string, string];
  if (encoded.length === 0 || providedMac.length === 0) return { ok: false, code: 'malformed' };

  const expected = mac(oauthStateKey(encryptionKeyBase64), encoded);
  let provided: Buffer;
  try {
    provided = Buffer.from(providedMac, 'base64url');
  } catch {
    return { ok: false, code: 'bad_signature' };
  }
  if (provided.length !== expected.length) return { ok: false, code: 'bad_signature' };
  // CANONICALITY: Node's base64url decoder IGNORES the unused padding bits of the
  // final character, so several distinct strings can decode to the same 32 bytes.
  // Re-encoding and comparing makes the mapping one-to-one, which is what this
  // artifact should be: exactly one accepted spelling per signature. Without it a
  // "changed" state could still verify — harmless (those bits carry no MAC data)
  // but confusing to audit, and it would hide a genuine signature change behind an
  // apparently-modified string.
  if (provided.toString('base64url') !== providedMac) return { ok: false, code: 'bad_signature' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, code: 'bad_signature' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'malformed' };
  }
  const payload = readPayload(parsed);
  if (payload === null) return { ok: false, code: 'malformed' };
  if (payload.exp <= Math.floor(now.getTime() / 1000)) return { ok: false, code: 'expired' };
  return { ok: true, payload };
}

/** Strict field-by-field read: an unexpected shape is a rejection, not a default. */
function readPayload(value: unknown): OAuthStatePayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.v !== OAUTH_STATE_VERSION) return null;
  if (typeof body.jti !== 'string' || body.jti.length < 8 || body.jti.length > 128) return null;
  if (typeof body.accountId !== 'string' || body.accountId.length === 0) return null;
  if (!isGoogleOAuthProvider(body.provider)) return null;
  if (typeof body.iat !== 'number' || !Number.isFinite(body.iat)) return null;
  if (typeof body.exp !== 'number' || !Number.isFinite(body.exp)) return null;
  if (body.exp <= body.iat) return null;
  return {
    v: body.v,
    jti: body.jti,
    accountId: body.accountId,
    provider: body.provider,
    iat: body.iat,
    exp: body.exp,
  };
}

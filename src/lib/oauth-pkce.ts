/**
 * PKCE (RFC 7636) pair generation for the Google OAuth flow.
 *
 * Why PKCE at all when we already have a client secret: the authorization code
 * travels through the user's browser (Google redirects to our callback URL), and
 * the code_verifier is the only thing that ties a redeemed code to the client
 * that asked for it. It costs one hash and removes a whole class of
 * code-interception attack, including on a shared or logged redirect.
 *
 * `S256` only — never `plain`, which would put the verifier in the URL.
 */

import { createHash, randomBytes } from 'node:crypto';

/** RFC 7636 §4.1: 43–128 characters of the unreserved set. 32 random bytes
 * base64url-encode to exactly 43 characters, all of them unreserved. */
const VERIFIER_BYTES = 32;

export interface PkcePair {
  /** Secret. Stored server-side, encrypted, and never sent to the browser. */
  verifier: string;
  /** Sent in the authorization URL as `code_challenge`. */
  challenge: string;
  method: 'S256';
}

/** `BASE64URL(SHA256(ASCII(verifier)))`, per RFC 7636 §4.2. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A fresh verifier/challenge pair: one random verifier, its S256 challenge. */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(VERIFIER_BYTES).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

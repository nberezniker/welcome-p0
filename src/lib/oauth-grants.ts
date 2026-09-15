/**
 * Server-side storage for OAuth grants (`oauth_grants`, migration 013).
 *
 * The one rule this module exists to enforce: TOKEN MATERIAL NEVER LEAVES IT
 * EXCEPT AS AN ACCESS TOKEN FOR AN OUTBOUND GOOGLE CALL. Concretely:
 *
 *   - tokens are written and read through AES-256-GCM (src/lib/crypto.ts,
 *     ENCRYPTION_KEY), exactly like contact values — the database never holds a
 *     plaintext token and no column is a plaintext fallback;
 *   - `loadGoogleAccessToken` is the ONLY function that returns a token, and it
 *     returns just an access token, never the refresh token;
 *   - everything a route or a page needs to DISPLAY comes from
 *     `loadGoogleGrantStates`, which projects a grant as a state word and the
 *     scopes' presence — no token, no expiry timestamp that a client could use
 *     to reason about anything, nothing to leak into HTML or JSON;
 *   - a revoked grant is KEPT (stamped `revoked_at`) so the UI can say
 *     "revoked", while a user-initiated disconnect HARD DELETES the row: those
 *     are different facts and the schema stores them differently.
 *
 * Account deletion needs no code here: both tables CASCADE from accounts(id).
 */

import type { Sql, TransactionSql } from 'postgres';
import { decryptValue, encryptValue } from './crypto';
import { requireEncryptionKey } from './env';
import { GoogleApiError, refreshAccessToken } from './google-api';
import {
  GOOGLE_SCOPES,
  googleGrantState,
  isConsentRevoked,
  needsRefresh,
  scopesCover,
  type GoogleApiErrorCode,
  type GoogleGrantFacts,
  type GoogleGrantState,
  type GoogleOAuthProvider,
  type GoogleTokenSet,
} from '../domain/google-oauth';

type SqlLike = Sql | TransactionSql;

/** The raw row, as it exists in the database. Never returned outside this module. */
interface GrantRow {
  id: string;
  provider: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  scopes: string[];
  expires_at: Date | null;
  refresh_failed_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

/** What a page/route is allowed to know about a grant. No token, ever. */
export interface GoogleGrantSummary {
  provider: GoogleOAuthProvider;
  state: GoogleGrantState;
  /** Scopes present on the stored grant (for "what did we get" wording only). */
  scopes: readonly string[];
  /** Human-meaningless but useful on /me/security: when the user connected. */
  connectedAt: string | null;
}

/** Insert or replace a grant after a successful authorization-code exchange. */
export async function upsertGrant(
  sql: SqlLike,
  opts: { accountId: string; provider: GoogleOAuthProvider; tokens: GoogleTokenSet },
): Promise<void> {
  const key = requireEncryptionKey();
  const accessToken = encryptValue(opts.tokens.accessToken, key);
  const refreshToken = opts.tokens.refreshToken === null ? null : encryptValue(opts.tokens.refreshToken, key);
  const scopes = opts.tokens.scopes.length > 0 ? [...opts.tokens.scopes] : [...GOOGLE_SCOPES[opts.provider]];

  await sql`
    INSERT INTO oauth_grants (
      account_id, provider, access_token_encrypted, refresh_token_encrypted,
      scopes, token_type, expires_at, refresh_failed_at, revoked_at, revoked_reason
    )
    VALUES (
      ${opts.accountId}, ${opts.provider}, ${accessToken}, ${refreshToken},
      ${scopes}::text[], ${opts.tokens.tokenType}, ${opts.tokens.expiresAt}, NULL, NULL, NULL
    )
    ON CONFLICT (account_id, provider) DO UPDATE SET
      access_token_encrypted = EXCLUDED.access_token_encrypted,
      -- A refresh response carries no refresh token: keep the stored one rather
      -- than overwriting a working renewal path with NULL.
      refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, oauth_grants.refresh_token_encrypted),
      scopes = EXCLUDED.scopes,
      token_type = EXCLUDED.token_type,
      expires_at = EXCLUDED.expires_at,
      refresh_failed_at = NULL,
      revoked_at = NULL,
      revoked_reason = NULL,
      updated_at = now()
  `;
}

/** Records a successful silent refresh. Never touches the refresh token. */
export async function recordGrantRefresh(
  sql: SqlLike,
  opts: { accountId: string; provider: GoogleOAuthProvider; tokens: GoogleTokenSet },
): Promise<void> {
  const key = requireEncryptionKey();
  const accessToken = encryptValue(opts.tokens.accessToken, key);
  await sql`
    UPDATE oauth_grants
    SET access_token_encrypted = ${accessToken},
        expires_at = ${opts.tokens.expiresAt},
        refresh_failed_at = NULL,
        updated_at = now()
    WHERE account_id = ${opts.accountId} AND provider = ${opts.provider}
  `;
}

/**
 * Records "we tried to renew and could not".
 *
 * `invalid_grant` is special: it does not mean the network is down, it means
 * GOOGLE NO LONGER HAS OUR CONSENT — the user revoked access on their account
 * page (or the refresh token expired after long disuse). That is stamped as a
 * revocation with its reason, so the UI can say "revoked — reconnect" instead of
 * "expired", and the next connect simply replaces the row.
 */
export async function recordGrantRefreshFailure(
  sql: SqlLike,
  opts: { accountId: string; provider: GoogleOAuthProvider; code: GoogleApiErrorCode },
): Promise<void> {
  if (isConsentRevoked(opts.code)) {
    await sql`
      UPDATE oauth_grants
      SET revoked_at = now(),
          revoked_reason = ${opts.code},
          refresh_failed_at = now(),
          updated_at = now()
      WHERE account_id = ${opts.accountId} AND provider = ${opts.provider}
    `;
    return;
  }
  await sql`
    UPDATE oauth_grants
    SET refresh_failed_at = now(), updated_at = now()
    WHERE account_id = ${opts.accountId} AND provider = ${opts.provider}
  `;
}

/** Hard delete (user-initiated disconnect). Returns true when a row existed. */
export async function deleteGrant(
  sql: SqlLike,
  opts: { accountId: string; provider: GoogleOAuthProvider },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM oauth_grants
    WHERE account_id = ${opts.accountId} AND provider = ${opts.provider}
    RETURNING id
  `;
  return rows.length > 0;
}

/** The stored refresh token, in plaintext, for the one caller that must refresh. */
async function loadRefreshToken(sql: SqlLike, accountId: string, provider: GoogleOAuthProvider): Promise<string | null> {
  const rows = await sql<{ refresh_token_encrypted: string | null }[]>`
    SELECT refresh_token_encrypted FROM oauth_grants
    WHERE account_id = ${accountId} AND provider = ${provider}
    LIMIT 1
  `;
  const encrypted = rows[0]?.refresh_token_encrypted;
  if (!encrypted) return null;
  try {
    return decryptValue(encrypted, requireEncryptionKey());
  } catch {
    // An undecryptable row (rotated ENCRYPTION_KEY) is treated as absent: the
    // honest answer is "reconnect", never a crash and never a wrong token.
    return null;
  }
}

/** Loads raw facts about one grant, without exposing anything decryptable. */
async function loadGrantFacts(
  sql: SqlLike,
  accountId: string,
  provider: GoogleOAuthProvider,
): Promise<{ row: GrantRow; facts: GoogleGrantFacts } | null> {
  const rows = await sql<GrantRow[]>`
    SELECT id, provider, access_token_encrypted, refresh_token_encrypted, scopes,
           expires_at, refresh_failed_at, revoked_at, revoked_reason
    FROM oauth_grants
    WHERE account_id = ${accountId} AND provider = ${provider}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    row,
    facts: {
      scopes: row.scopes ?? [],
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      refreshFailedAt: row.refresh_failed_at ? new Date(row.refresh_failed_at) : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
      hasRefreshToken: row.refresh_token_encrypted !== null,
    },
  };
}

/**
 * A USABLE access token for one provider, or null with the honest reason.
 *
 * Refreshes when the stored token is past its expiry, records the outcome
 * either way, and never returns a token for a grant that is revoked or missing a
 * scope we need — a caller must not be able to make a doomed Google call and
 * then guess why it failed.
 */
export interface AccessTokenRequest {
  accountId: string;
  provider: GoogleOAuthProvider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  now?: Date;
}

export type AccessTokenOutcome =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'not_connected' | 'revoked' | 'expired' | 'refresh_failed' };

export async function loadGoogleAccessToken(
  sql: SqlLike,
  opts: AccessTokenRequest,
): Promise<AccessTokenOutcome> {
  const now = opts.now ?? new Date();
  const loaded = await loadGrantFacts(sql, opts.accountId, opts.provider);
  if (loaded === null) return { ok: false, reason: 'not_connected' };
  const { row, facts } = loaded;

  const state = googleGrantState(facts, GOOGLE_SCOPES[opts.provider], now);
  if (state === 'revoked') return { ok: false, reason: 'revoked' };
  if (state === 'expired') return { ok: false, reason: 'expired' };

  if (!needsRefresh(facts, now)) {
    const accessToken = decryptRowValue(row.access_token_encrypted);
    if (accessToken === null) return { ok: false, reason: 'expired' };
    return { ok: true, accessToken };
  }

  const refreshToken = await loadRefreshToken(sql, opts.accountId, opts.provider);
  if (refreshToken === null) return { ok: false, reason: 'expired' };

  try {
    const tokens = await refreshAccessToken({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      redirectUri: opts.redirectUri,
      refreshToken,
    });
    await recordGrantRefresh(sql, { accountId: opts.accountId, provider: opts.provider, tokens });
    // Google may narrow the scopes on a refresh; if a scope we need is now gone,
    // say so instead of making a call that would come back 403.
    if (!scopesCover(tokens.scopes.length > 0 ? tokens.scopes : row.scopes ?? [], GOOGLE_SCOPES[opts.provider])) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, accessToken: tokens.accessToken };
  } catch (err) {
    // `GoogleApiError` carries a typed code; anything else is a transport-level
    // failure we could not classify, which is neither a revocation nor a success.
    const code: GoogleApiErrorCode =
      err instanceof GoogleApiError ? err.code : 'network_error';
    await recordGrantRefreshFailure(sql, { accountId: opts.accountId, provider: opts.provider, code });
    return { ok: false, reason: code === 'invalid_grant' ? 'revoked' : 'refresh_failed' };
  }
}

function decryptRowValue(encrypted: string): string | null {
  try {
    return decryptValue(encrypted, requireEncryptionKey());
  } catch {
    return null;
  }
}

/**
 * The DISPLAY projection for /me/connections: one entry per provider the account
 * has a grant for, plus `not_connected` for the rest. Contains no token, no
 * ciphertext and no expiry instant — the page needs a word, and a word is all it
 * gets.
 */
export async function loadGoogleGrantStates(
  sql: SqlLike,
  accountId: string | null,
  providers: readonly GoogleOAuthProvider[],
  now: Date = new Date(),
): Promise<GoogleGrantSummary[]> {
  if (accountId === null) {
    return providers.map((provider) => ({
      provider,
      state: 'not_connected' as const,
      scopes: [],
      connectedAt: null,
    }));
  }
  const rows = await sql<(GrantRow & { created_at: Date })[]>`
    SELECT id, provider, access_token_encrypted, refresh_token_encrypted, scopes,
           expires_at, refresh_failed_at, revoked_at, revoked_reason, created_at
    FROM oauth_grants
    WHERE account_id = ${accountId} AND provider = ANY(${[...providers]}::text[])
  `;
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return providers.map((provider) => {
    const row = byProvider.get(provider);
    if (!row) {
      return { provider, state: 'not_connected' as const, scopes: [], connectedAt: null };
    }
    const state = googleGrantState(
      {
        scopes: row.scopes ?? [],
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
        refreshFailedAt: row.refresh_failed_at ? new Date(row.refresh_failed_at) : null,
        revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
        hasRefreshToken: row.refresh_token_encrypted !== null,
      },
      GOOGLE_SCOPES[provider],
      now,
    );
    return {
      provider,
      state,
      scopes: row.scopes ?? [],
      connectedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  });
}

/** Wired by the disconnect route: we need the token that is about to be deleted. */
export async function loadAccessTokenForRevocation(
  sql: SqlLike,
  accountId: string,
  provider: GoogleOAuthProvider,
): Promise<string | null> {
  const rows = await sql<{ access_token_encrypted: string }[]>`
    SELECT access_token_encrypted FROM oauth_grants
    WHERE account_id = ${accountId} AND provider = ${provider}
    LIMIT 1
  `;
  const encrypted = rows[0]?.access_token_encrypted;
  if (!encrypted) return null;
  return decryptRowValue(encrypted);
}

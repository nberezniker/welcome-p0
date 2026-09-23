/**
 * The in-flight half of an OAuth authorization attempt (`oauth_flow_states`,
 * migration 013).
 *
 * A signed `state` proves authenticity but NOT freshness — a signature stays
 * valid for as long as the deployment's key does. The `jti` in the state is the
 * primary key of a row here, and `consumeFlowState` claims it with a single
 * conditional UPDATE:
 *
 *     SET consumed_at = now() WHERE jti = $1 AND consumed_at IS NULL AND expires_at > now()
 *
 * Whoever wins that statement gets the PKCE verifier; everybody else gets null.
 * That is what makes the state SINGLE USE even for two callbacks arriving at the
 * same instant on two serverless instances, which no amount of signature
 * checking can achieve.
 *
 * The verifier is stored ENCRYPTED (same AES-256-GCM module as tokens), because
 * the PKCE verifier is a secret: someone who reads it and intercepts a code could
 * redeem it. The client never sees it — the state carries only the `jti`.
 *
 * Rows are short-lived (10 minutes) and are deleted by the retention cleanup pass
 * (src/infra/cleanup.ts) as well as opportunistically when a new flow starts, so
 * an abandoned attempt leaves no lasting trace.
 */

import type { Sql, TransactionSql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { decryptStored, encryptStored } from './crypto';
import { requireKeyring } from './env';
import { safeNextPath } from './redirect';
import type { GoogleOAuthProvider } from '../domain/google-oauth';

type SqlLike = Sql | TransactionSql;

/** Random 128-bit flow id. Opaque, unguessable, and the row's primary key. */
export function generateFlowId(): string {
  return randomBytes(16).toString('base64url');
}

export interface StartedFlow {
  jti: string;
}

/**
 * Stores the server-side half of a flow and returns its id.
 *
 * `redirectPath` is validated with the app's own `safeNextPath` (F-10) before it
 * is written: the callback uses it to send the user back, and a stored path is
 * only ever a LOCAL one, so a tampered state cannot turn the callback into an
 * open redirect even though the state is what carries the value.
 */
export async function startFlowState(
  sql: SqlLike,
  opts: {
    accountId: string;
    provider: GoogleOAuthProvider;
    codeVerifier: string;
    ttlSeconds: number;
    redirectPath?: string | null;
  },
): Promise<StartedFlow> {
  const jti = generateFlowId();
  const verifier = encryptStored(opts.codeVerifier, requireKeyring());
  const redirectPath = safeNextPath(opts.redirectPath ?? null) ?? '/me/connections';

  await sql`
    INSERT INTO oauth_flow_states (jti, account_id, provider, code_verifier_encrypted, redirect_path, expires_at)
    VALUES (
      ${jti}, ${opts.accountId}, ${opts.provider}, ${verifier}, ${redirectPath},
      now() + (${opts.ttlSeconds} * interval '1 second')
    )
  `;
  return { jti };
}

export interface ConsumedFlow {
  accountId: string;
  provider: GoogleOAuthProvider;
  codeVerifier: string;
  redirectPath: string;
}

/**
 * Claims a flow, exactly once. Returns null when the jti is unknown, already
 * spent, or past its expiry — three honest "no"s that the callback cannot and
 * must not distinguish to the user (it reports one `invalid_state` flag).
 *
 * A row whose verifier cannot be decrypted is treated as unusable AND stays
 * consumed: the attempt is dead either way, and re-consuming it could not help.
 */
export async function consumeFlowState(sql: SqlLike, jti: string): Promise<ConsumedFlow | null> {
  const rows = await sql<{
    account_id: string;
    provider: string;
    code_verifier_encrypted: string;
    redirect_path: string;
  }[]>`
    UPDATE oauth_flow_states
    SET consumed_at = now()
    WHERE jti = ${jti}
      AND consumed_at IS NULL
      AND expires_at > now()
    RETURNING account_id, provider, code_verifier_encrypted, redirect_path
  `;
  const row = rows[0];
  if (!row) return null;

  let codeVerifier: string;
  try {
    codeVerifier = decryptStored(row.code_verifier_encrypted, requireKeyring());
  } catch {
    return null;
  }

  const redirectPath = safeNextPath(row.redirect_path) ?? '/me/connections';
  return {
    accountId: row.account_id,
    provider: row.provider as GoogleOAuthProvider,
    codeVerifier,
    redirectPath,
  };
}

/**
 * Deletes spent and expired rows. Called opportunistically on `start` and by the
 * retention pass; returns how many rows went, for the cleanup log line.
 */
export async function purgeExpiredFlowStates(sql: SqlLike, olderThanSeconds = 0): Promise<number> {
  const rows = await sql<{ jti: string }[]>`
    DELETE FROM oauth_flow_states
    WHERE expires_at < now() - (${olderThanSeconds} * interval '1 second')
       OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 hour')
    RETURNING jti
  `;
  return rows.length;
}

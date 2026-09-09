import type { Sql } from 'postgres';
import { encryptValue, decryptValue } from './crypto';
import { requireEncryptionKey } from './env';
import {
  RECOVERY_CODES_COUNT,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotp,
} from './totp';

/**
 * F-03: DB operations for MFA (TOTP step-up). Secrets are only ever persisted
 * encrypted (AES-256-GCM, ENCRYPTION_KEY); recovery codes only as SHA-256
 * hashes. Wrong-code attempts are recorded as fact rows in mfa_verify_failures
 * — the same durable sliding-window throttle pattern as otp_verify_failures
 * (migration 005): >= 5 failures within the window lock verification until it
 * slides clear.
 */

export const MFA_VERIFY_WINDOW_MINUTES = 15;
/** Max wrong MFA verifications per account within the window. */
export const MFA_VERIFY_WINDOW_MAX = 5;

export interface MfaCredentialRow {
  secret_encrypted: string;
  confirmed_at: Date | null;
}

/** Loads the account's (single) TOTP credential, pending or confirmed. */
export async function getMfaCredential(sql: Sql, accountId: string): Promise<MfaCredentialRow | null> {
  const rows = await sql<{ secret_encrypted: string; confirmed_at: Date | null }[]>`
    SELECT secret_encrypted, confirmed_at FROM mfa_credentials WHERE account_id = ${accountId} LIMIT 1
  `;
  return rows[0] ?? null;
}

/** True when the account has a CONFIRMED TOTP factor (enrollment pending does not count). */
export async function hasConfirmedMfa(sql: Sql, accountId: string): Promise<boolean> {
  const rows = await sql<{ confirmed_at: Date | null }[]>`
    SELECT confirmed_at FROM mfa_credentials WHERE account_id = ${accountId} LIMIT 1
  `;
  return rows[0]?.confirmed_at != null;
}

/** Count of failed MFA verifications in the sliding window. */
export async function mfaFailureCount(sql: Sql, accountId: string): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM mfa_verify_failures
    WHERE account_id = ${accountId}
      AND attempted_at > now() - (${MFA_VERIFY_WINDOW_MINUTES} * interval '1 minute')
  `;
  return rows[0]?.count ?? 0;
}

export async function recordMfaFailure(sql: Sql, accountId: string): Promise<void> {
  await sql`INSERT INTO mfa_verify_failures (account_id) VALUES (${accountId})`;
}

export async function clearMfaFailures(sql: Sql, accountId: string): Promise<void> {
  await sql`DELETE FROM mfa_verify_failures WHERE account_id = ${accountId}`;
}

// ---------------------------------------------------------------------------
// Enrollment (POST /api/me/mfa/totp): create or rotate the pending secret and
// (re)issue recovery codes. Rotation of an already-confirmed credential is
// decided by the route (requires a valid code there).
// ---------------------------------------------------------------------------

export async function enrollTotp(
  sql: Sql,
  accountId: string,
): Promise<{ secretBase32: string; recoveryCodes: string[] }> {
  const key = requireEncryptionKey();
  const secretBase32 = generateTotpSecret();
  const codes = generateRecoveryCodes();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO mfa_credentials (account_id, kind, secret_encrypted, confirmed_at)
      VALUES (${accountId}, 'totp', ${encryptValue(secretBase32, key)}, NULL)
      ON CONFLICT (account_id) DO UPDATE
        SET kind = 'totp', secret_encrypted = EXCLUDED.secret_encrypted,
            confirmed_at = NULL, created_at = now()
    `;
    // Full replace: previously issued (possibly confirmed-credential) codes are void.
    await tx`DELETE FROM mfa_recovery_codes WHERE account_id = ${accountId}`;
    for (const code of codes) {
      await tx`INSERT INTO mfa_recovery_codes (account_id, code_hash) VALUES (${accountId}, ${hashRecoveryCode(code)})`;
    }
    await clearMfaFailures(tx as unknown as Sql, accountId);
  });
  return { secretBase32, recoveryCodes: codes };
}

/** Decrypts the stored secret for verification / QR display. Throws on tampering. */
export function decryptTotpSecret(row: MfaCredentialRow): string {
  return decryptValue(row.secret_encrypted, requireEncryptionKey());
}

// ---------------------------------------------------------------------------
// Confirmation (POST /api/me/mfa/totp/confirm)
// ---------------------------------------------------------------------------

export type MfaConfirmResult = 'ok' | 'missing' | 'locked' | 'invalid';

/** Confirms the pending credential with a TOTP code. Caller maps results to HTTP. */
export async function confirmTotpEnrollment(sql: Sql, accountId: string, code: string): Promise<MfaConfirmResult> {
  const row = await getMfaCredential(sql, accountId);
  if (!row) return 'missing';
  if (row.confirmed_at != null) return 'ok'; // already confirmed — idempotent
  if ((await mfaFailureCount(sql, accountId)) >= MFA_VERIFY_WINDOW_MAX) return 'locked';
  const secret = decryptTotpSecret(row);
  if (!verifyTotp(secret, code)) {
    await recordMfaFailure(sql, accountId);
    return 'invalid';
  }
  await sql`UPDATE mfa_credentials SET confirmed_at = now() WHERE account_id = ${accountId}`;
  await clearMfaFailures(sql, accountId);
  return 'ok';
}

// ---------------------------------------------------------------------------
// Disable (DELETE /api/me/mfa): requires a valid TOTP code — the owner has no
// other second factor, so the code IS the confirmation (spec §9 F-03).
// ---------------------------------------------------------------------------

export type MfaDisableResult = 'ok' | 'missing' | 'locked' | 'invalid';

export async function disableMfa(sql: Sql, accountId: string, code: string): Promise<MfaDisableResult> {
  const row = await getMfaCredential(sql, accountId);
  if (!row || row.confirmed_at == null) return 'missing';
  if ((await mfaFailureCount(sql, accountId)) >= MFA_VERIFY_WINDOW_MAX) return 'locked';
  const secret = decryptTotpSecret(row);
  if (!verifyTotp(secret, code)) {
    await recordMfaFailure(sql, accountId);
    return 'invalid';
  }
  await sql.begin(async (tx) => {
    await tx`DELETE FROM mfa_credentials WHERE account_id = ${accountId}`;
    await tx`DELETE FROM mfa_recovery_codes WHERE account_id = ${accountId}`;
    await tx`DELETE FROM mfa_verify_failures WHERE account_id = ${accountId}`;
  });
  return 'ok';
}

// ---------------------------------------------------------------------------
// Session step-up (POST /api/auth/mfa/verify): TOTP code OR a single-use
// recovery code marks the session as MFA-verified.
// ---------------------------------------------------------------------------

export type MfaVerifyResult =
  | { outcome: 'ok'; via: 'totp' | 'recovery' }
  | { outcome: 'missing' | 'locked' | 'invalid' };

/** Consumes one recovery code (race-safe single use) if it matches. */
async function consumeRecoveryCode(sql: Sql, accountId: string, code: string): Promise<boolean> {
  const hash = hashRecoveryCode(code);
  const rows = await sql<{ id: string }[]>`
    UPDATE mfa_recovery_codes
    SET used_at = now()
    WHERE id = (
      SELECT id FROM mfa_recovery_codes
      WHERE account_id = ${accountId} AND code_hash = ${hash} AND used_at IS NULL
      LIMIT 1
    )
    AND used_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Verifies a TOTP or recovery code for the account and stamps the session.
 * Enumeration-safe by construction: the caller answers every failure branch
 * with the same `401 mfa_invalid` payload.
 */
export async function verifyMfaForSession(
  sql: Sql,
  sessionId: string,
  accountId: string,
  code: string,
): Promise<MfaVerifyResult> {
  const row = await getMfaCredential(sql, accountId);
  if (!row || row.confirmed_at == null) return { outcome: 'missing' };
  if ((await mfaFailureCount(sql, accountId)) >= MFA_VERIFY_WINDOW_MAX) return { outcome: 'locked' };

  const secret = decryptTotpSecret(row);
  // Recovery code first only when the shape matches (XXXX-XXXX normalized to 8
  // chars) so a 6-digit TOTP never burns a lookup, and vice versa.
  const looksLikeRecovery = code.replace(/[^a-zA-Z0-9]/g, '').length !== 6;
  if (looksLikeRecovery && (await consumeRecoveryCode(sql, accountId, code))) {
    await sql`UPDATE sessions SET mfa_verified_at = now() WHERE id = ${sessionId}`;
    await clearMfaFailures(sql, accountId);
    return { outcome: 'ok', via: 'recovery' };
  }
  if (verifyTotp(secret, code)) {
    await sql`UPDATE sessions SET mfa_verified_at = now() WHERE id = ${sessionId}`;
    await clearMfaFailures(sql, accountId);
    return { outcome: 'ok', via: 'totp' };
  }
  // A failed TOTP-shaped guess must not consume a recovery code attempt row
  // silently — record it for the account-level window.
  await recordMfaFailure(sql, accountId);
  return { outcome: 'invalid' };
}

/** Remaining (unused) recovery codes for the status page. */
export async function unusedRecoveryCodeCount(sql: Sql, accountId: string): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM mfa_recovery_codes
    WHERE account_id = ${accountId} AND used_at IS NULL
  `;
  return rows[0]?.count ?? 0;
}

export { RECOVERY_CODES_COUNT };

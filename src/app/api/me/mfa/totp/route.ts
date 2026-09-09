import QRCode from 'qrcode';
import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { requireHashPepper } from '../../../../../lib/env';
import { emailLookupHash, timingSafeHexEqual } from '../../../../../lib/crypto';
import { asString, internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../../lib/http';
import { decryptTotpSecret, enrollTotp, getMfaCredential, mfaFailureCount, recordMfaFailure, MFA_VERIFY_WINDOW_MAX } from '../../../../../lib/mfa';
import { otpauthUri, verifyTotp } from '../../../../../lib/totp';

/**
 * POST /api/me/mfa/totp — F-03 enrollment / rotation (auth required, account
 * active). Creates (or rotates) a pending TOTP secret and issues 8 single-use
 * recovery codes; both are returned ONCE and never stored in plaintext /
 * unhashed form respectively. The otpauth label carries the account's email —
 * the raw email is supplied by the client, validated against the stored
 * email_lookup_hash and never persisted (only the secret is, encrypted).
 * Rotating an already-CONFIRMED factor requires a valid TOTP code in the body.
 */
async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const email = asString(b.email, { maxLength: 320 });
    if (!email) {
      return jsonError(400, 'invalid_input', 'email is required for the otpauth label');
    }

    const sql = getSql();
    const pepper = requireHashPepper();

    // The label email must be the account's own login email (no third-party labels).
    const accountRows = await sql<{ email_lookup_hash: string | null }[]>`
      SELECT email_lookup_hash FROM accounts WHERE id = ${auth.accountId} LIMIT 1
    `;
    const storedHash = accountRows[0]?.email_lookup_hash ?? null;
    if (storedHash) {
      const suppliedHash = emailLookupHash(email, pepper);
      if (!timingSafeHexEqual(storedHash, suppliedHash)) {
        return jsonError(400, 'invalid_input', 'email does not match this account');
      }
    }

    // Rotation guard: a confirmed factor may only be replaced with a valid code.
    const existing = await getMfaCredential(sql, auth.accountId);
    if (existing && existing.confirmed_at != null) {
      if ((await mfaFailureCount(sql, auth.accountId)) >= MFA_VERIFY_WINDOW_MAX) {
        return jsonError(400, 'mfa_invalid_code', 'Invalid or expired code');
      }
      if (!verifyTotp(decryptTotpSecret(existing), asString(b.code) ?? '')) {
        await recordMfaFailure(sql, auth.accountId);
        return jsonError(400, 'mfa_invalid_code', 'Invalid or expired code');
      }
    }

    const enrolled = await enrollTotp(sql, auth.accountId);
    const uri = otpauthUri(email, enrolled.secretBase32);
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240 });

    return jsonOk({
      ok: true,
      secret_base32: enrolled.secretBase32,
      otpauth_uri: uri,
      qr_data_url: qrDataUrl,
      recovery_codes: enrolled.recoveryCodes,
    });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

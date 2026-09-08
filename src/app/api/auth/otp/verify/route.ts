import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireHashPepper } from '../../../../../lib/env';
import { emailLookupHash, hashOtpCode, timingSafeHexEqual } from '../../../../../lib/crypto';
import { internalError, jsonError, jsonOk, normalizeEmail, readJsonBody, withApi } from '../../../../../lib/http';
import { createSession, setSessionCookie } from '../../../../../lib/auth';

/** Max wrong attempts per OTP before it is invalidated. */
const OTP_MAX_ATTEMPTS = 5;

// F-13: DB-backed per-account failed-verify window. The in-memory per-IP
// bucket is per-instance; this counter is durable across instances. The
// response stays the enumeration-safe `401 invalid_code` in every branch.
const OTP_VERIFY_WINDOW_MINUTES = 15;
const OTP_VERIFY_WINDOW_MAX = 5;

async function postRoute(req: NextRequest) {
  try {
    const body = await readJsonBody(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const email = normalizeEmail(b.email);
    const code = typeof b.code === 'string' ? b.code.trim() : '';
    if (!email || !/^\d{6}$/.test(code)) {
      return jsonError(400, 'invalid_input', 'email and a 6-digit code are required');
    }

    const pepper = requireHashPepper();
    const sql = getSql();
    const lookupHash = emailLookupHash(email, pepper);
    const suppliedHash = hashOtpCode(code, pepper);

    const accountRows = await sql<{ id: string }[]>`
      SELECT id FROM accounts WHERE email_lookup_hash = ${lookupHash} LIMIT 1
    `;
    const account = accountRows[0];
    if (!account) {
      // Enumeration-safe: identical response to a wrong code. Burn a dummy hash to even out timing.
      hashOtpCode('000000', pepper);
      return jsonError(401, 'invalid_code', 'Invalid or expired code');
    }

    // F-13: >= 5 recorded failures within the window lock ALL verifies for
    // this account (even a correct code) until the window slides clear.
    const failures = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM otp_verify_failures
      WHERE account_id = ${account.id}
        AND attempted_at > now() - (${OTP_VERIFY_WINDOW_MINUTES} * interval '1 minute')
    `;
    if ((failures[0]?.count ?? 0) >= OTP_VERIFY_WINDOW_MAX) {
      hashOtpCode('000000', pepper); // timing parity with the wrong-code path
      return jsonError(401, 'invalid_code', 'Invalid or expired code');
    }

    const otpRows = await sql<{ id: string; code_hash: string; attempts: number }[]>`
      SELECT id, code_hash, attempts
      FROM auth_otp_codes
      WHERE account_id = ${account.id}
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const otp = otpRows[0];
    if (!otp) {
      return jsonError(401, 'invalid_code', 'Invalid or expired code');
    }

    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await sql`UPDATE auth_otp_codes SET consumed_at = now() WHERE id = ${otp.id} AND consumed_at IS NULL`;
      return jsonError(401, 'invalid_code', 'Invalid or expired code');
    }

    if (!timingSafeHexEqual(otp.code_hash, suppliedHash)) {
      const updated = await sql<{ attempts: number }[]>`
        UPDATE auth_otp_codes
        SET attempts = attempts + 1,
            consumed_at = CASE WHEN attempts + 1 >= ${OTP_MAX_ATTEMPTS} THEN now() ELSE consumed_at END
        WHERE id = ${otp.id}
        RETURNING attempts
      `;
      void updated;
      // F-13: record the failure for the account-level window.
      await sql`INSERT INTO otp_verify_failures (account_id) VALUES (${account.id})`;
      return jsonError(401, 'invalid_code', 'Invalid or expired code');
    }

    // Correct code: consume it, invalidate any older codes, create the session.
    const issued = await sql.begin(async (tx) => {
      const consumed = await tx`
        UPDATE auth_otp_codes SET consumed_at = now()
        WHERE id = ${otp.id} AND consumed_at IS NULL
        RETURNING id
      `;
      if (consumed.length === 0) return null; // concurrent use — treat as expired
      await tx`
        UPDATE auth_otp_codes SET consumed_at = now()
        WHERE account_id = ${account.id} AND consumed_at IS NULL
      `;
      await tx`DELETE FROM otp_verify_failures WHERE account_id = ${account.id}`;
      return createSession(account.id, tx);
    });

    if (!issued) {
      return jsonError(401, 'invalid_code', 'Invalid or expired code');
    }

    const res = jsonOk({ ok: true });
    setSessionCookie(res, issued.token, issued.expiresAt);
    return res;
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

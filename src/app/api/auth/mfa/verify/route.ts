import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { asString, internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../../lib/http';
import { verifyMfaForSession } from '../../../../../lib/mfa';

/**
 * POST /api/auth/mfa/verify — F-03 step-up: verifies a TOTP code OR a
 * single-use recovery code for the signed-in account and stamps the current
 * session as MFA-verified (sessions.mfa_verified_at = now()). Required before
 * owner-level organizer actions when the account has a confirmed MFA factor
 * (ADR 0007), e.g. right after login or when the 30-minute freshness window
 * has elapsed. Enumeration-safe: every failure branch (no factor, wrong code,
 * throttled) answers the same `401 mfa_invalid`; wrong codes are limited to
 * 5 per 15 minutes per account (mfa_verify_failures).
 */
async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const code = asString(b.code, { maxLength: 32 });
    if (!code) return jsonError(401, 'mfa_invalid', 'Invalid or expired code');

    const result = await verifyMfaForSession(getSql(), auth.sessionId, auth.accountId, code);
    if (result.outcome === 'ok') {
      return jsonOk({ ok: true, mfa_verified: true, via: result.via });
    }
    // missing (no confirmed factor) / locked / invalid — identical response.
    return jsonError(401, 'mfa_invalid', 'Invalid or expired code');
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

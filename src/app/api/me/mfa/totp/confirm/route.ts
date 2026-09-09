import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { asString, internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../../../lib/http';
import { recordAudit } from '../../../../../../lib/audit';
import { confirmTotpEnrollment } from '../../../../../../lib/mfa';

/**
 * POST /api/me/mfa/totp/confirm — F-03: confirm a pending TOTP enrollment with
 * the current 6-digit code (±1 step). Confirms within the same account window:
 * wrong codes are throttled at 5 per 15 minutes (mfa_verify_failures). The
 * wrong-code response is identical to the locked response — nothing about the
 * factor's state leaks.
 */
async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const code = asString(b.code, { maxLength: 16 });
    if (!code) return jsonError(400, 'invalid_input', 'A 6-digit code is required');

    const result = await confirmTotpEnrollment(getSql(), auth.accountId, code);
    switch (result) {
      case 'ok':
        await recordAudit(undefined, auth.accountId, 'mfa.confirmed', 'account', auth.accountId, { kind: 'totp' });
        return jsonOk({ ok: true, confirmed: true });
      case 'missing':
        return jsonError(400, 'mfa_not_started', 'Start MFA enrollment first');
      case 'locked':
      case 'invalid':
        return jsonError(400, 'mfa_invalid_code', 'Invalid or expired code');
    }
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

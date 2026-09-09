import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { asString, internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../lib/http';
import { recordAudit } from '../../../../lib/audit';
import { disableMfa } from '../../../../lib/mfa';

/**
 * DELETE /api/me/mfa — F-03: disable MFA. Owner-controlled: only the account
 * itself can disable its factor, and the body MUST carry the current TOTP
 * code (the factor has no other second channel — the code IS the
 * confirmation, spec §9). Wrong codes are throttled (5 / 15 min per account).
 */
async function deleteRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const code = asString(b.code, { maxLength: 16 });
    if (!code) return jsonError(400, 'invalid_input', 'A current TOTP code is required');

    const result = await disableMfa(getSql(), auth.accountId, code);
    switch (result) {
      case 'ok':
        await recordAudit(undefined, auth.accountId, 'mfa.disabled', 'account', auth.accountId, { kind: 'totp' });
        return jsonOk({ ok: true, enabled: false });
      case 'missing':
        return jsonError(400, 'mfa_not_enabled', 'MFA is not enabled for this account');
      case 'locked':
      case 'invalid':
        return jsonError(400, 'mfa_invalid_code', 'Invalid or expired code');
    }
  } catch (err) {
    return internalError(err);
  }
}

export const DELETE = withApi(deleteRoute);

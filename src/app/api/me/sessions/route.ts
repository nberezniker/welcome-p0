import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { clearSessionCookie, requireAccount } from '../../../../lib/auth';
import { internalError, jsonError, jsonOk, privateCacheHeaders, withApi } from '../../../../lib/http';
import { loadActiveSessions } from '../../../../lib/sessions';
import { recordAudit } from '../../../../lib/audit';

export const dynamic = 'force-dynamic';

/**
 * Active sessions of the authenticated account.
 *
 * The response carries NO token material of any kind — sessions are identified
 * by an opaque row id the client echoes back to revoke one. User-agent and IP
 * are not stored at all (see db/migrations/010_session_last_seen.sql), so there
 * is nothing to mask.
 */

async function getRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const sessions = await loadActiveSessions(getSql(), auth.accountId, auth.sessionId);
    return jsonOk({ ok: true, sessions }, { headers: privateCacheHeaders() });
  } catch (err) {
    return internalError(err);
  }
}

/**
 * "Sign out on all devices": drops every session of the account, including the
 * caller's, and clears the cookie. The revoked-row count is reported honestly
 * (it includes the current one).
 */
async function deleteAllRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const sql = getSql();
    const deleted = await sql<{ id: string }[]>`
      DELETE FROM sessions WHERE account_id = ${auth.accountId} RETURNING id
    `;

    await recordAudit(sql, auth.accountId, 'sessions.revoked_all', 'account', auth.accountId, {
      revoked: deleted.length,
    });

    const res = jsonOk({ ok: true, revoked: deleted.length, current_revoked: true });
    clearSessionCookie(res);
    return res;
  } catch (err) {
    return internalError(err);
  }
}

export const GET = withApi(getRoute);
export const DELETE = withApi(deleteAllRoute);

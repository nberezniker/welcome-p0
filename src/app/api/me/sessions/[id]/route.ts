import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { clearSessionCookie, requireAccount } from '../../../../../lib/auth';
import { internalError, jsonError, jsonOk, withApi } from '../../../../../lib/http';
import { isUuid } from '../../../../../domain/organizer';
import { recordAudit } from '../../../../../lib/audit';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/me/sessions/[id] — revoke one session.
 *
 * A session that is not yours answers 404 (not 403) so the response never
 * confirms that somebody else's session id exists. Revoking the CURRENT session
 * is allowed: the row dies, the cookie is cleared, and the client sends the
 * user back to /login.
 */
async function deleteRoute(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { id } = await params;
    // A malformed id can match no row: it is "not found", never a 500 from a cast.
    if (!isUuid(id)) return jsonError(404, 'not_found', 'Session not found');

    const sql = getSql();
    // account_id in the WHERE clause is the whole authorization check: you can
    // only ever delete a row you own.
    const deleted = await sql<{ id: string }[]>`
      DELETE FROM sessions
      WHERE id = ${id}::uuid AND account_id = ${auth.accountId}
      RETURNING id
    `;
    if (!deleted[0]) return jsonError(404, 'not_found', 'Session not found');

    const currentRevoked = id === auth.sessionId;
    await recordAudit(sql, auth.accountId, 'session.revoked', 'session', id, { current: currentRevoked });

    const res = jsonOk({ ok: true, revoked: 1, current_revoked: currentRevoked });
    if (currentRevoked) clearSessionCookie(res);
    return res;
  } catch (err) {
    return internalError(err);
  }
}

export const DELETE = withApi(deleteRoute);

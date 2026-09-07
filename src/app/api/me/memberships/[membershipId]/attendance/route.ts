import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../../../lib/http';
import { requireOwnMembership } from '../../../../../../domain/membership';
import { recordAudit } from '../../../../../../lib/audit';

/** POST /api/me/memberships/[membershipId]/attendance — voluntary self-report.
 * This is a claim of presence, NEVER a ticket check: join/claim never sets it. */
async function postRoute(
  req: NextRequest,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { membershipId } = await params;
    const sql = getSql();
    const membership = await requireOwnMembership(sql, auth.accountId, membershipId);
    if (!membership) return jsonError(403, 'forbidden', 'This membership does not belong to you');

    const body = await readJsonBody(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof b.present !== 'boolean') {
      return jsonError(400, 'invalid_present', 'present must be a boolean');
    }

    const source = b.present ? 'self' : 'none';
    await sql`
      UPDATE event_memberships SET attendance_source = ${source}
      WHERE id = ${membership.id}
    `;

    await recordAudit(sql, auth.accountId, 'attendance.self_report', 'membership', membership.id, {
      present: b.present,
      event_id: membership.event_id,
    });

    return jsonOk({ ok: true, attendance_source: source });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

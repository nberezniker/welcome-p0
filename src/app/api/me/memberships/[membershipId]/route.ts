import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { jsonError, jsonOk, readJsonBody, internalError } from '../../../../../lib/http';
import { requireOwnMembership, validateMembershipPatch } from '../../../../../domain/membership';
import { recordAudit } from '../../../../../lib/audit';

/** PATCH /api/me/memberships/[membershipId] — the member updates their OWN
 * membership: directory visibility, per-event tag overrides, or leaving.
 * Organizer approval is never involved; state accepts only 'left'. */
export async function PATCH(
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
    const input = validateMembershipPatch(body);
    if (!input.ok) return jsonError(400, input.code, input.message);

    const rows = await sql<{ id: string; event_id: string; state: string; directory_visible: boolean; offer_tags: string[]; need_tags: string[] }[]>`
      UPDATE event_memberships SET
        directory_visible = ${input.value.directoryVisible ?? membership.directory_visible},
        offer_tags = ${input.value.offerTags ?? membership.offer_tags},
        need_tags = ${input.value.needTags ?? membership.need_tags},
        state = ${input.value.leave ? 'left' : membership.state}
      WHERE id = ${membership.id}
      RETURNING id, event_id, state, directory_visible, offer_tags, need_tags
    `;
    const row = rows[0]!;

    if (input.value.leave && membership.state !== 'left') {
      await recordAudit(sql, auth.accountId, 'membership.left', 'membership', membership.id, {
        event_id: membership.event_id,
      });
    }

    return jsonOk({ ok: true, membership: row });
  } catch (err) {
    return internalError(err);
  }
}

import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../lib/http';
import { recordAudit } from '../../../../lib/audit';
import { requireEventRole } from '../../../../domain/organizer';
import { validateCampaignCreate } from '../../../../domain/campaigns';

/**
 * POST /api/organizer/campaigns — create a draft campaign for one event.
 * Only the event's organizer owner/admin may create (staff → 403, AC-23
 * family). Content starts at revision 1, state 'draft'.
 */
async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = await readJsonBody(req);
    const input = validateCampaignCreate(body);
    if (!input.ok) return jsonError(400, input.code, input.message);

    const sql = getSql();
    const role = await requireEventRole(sql, auth.accountId, input.value.eventId, ['owner', 'admin']);
    if (!role) return jsonError(403, 'forbidden', 'Only the event organizer owner or admin can create campaigns');

    const rows = await sql<{ id: string; content_revision: number; state: string }[]>`
      INSERT INTO campaigns (organizer_id, event_id, purpose, body_text)
      VALUES (${role.organizerId}, ${input.value.eventId}, ${input.value.purpose}, ${input.value.bodyText})
      RETURNING id, content_revision, state
    `;
    const row = rows[0]!;
    await recordAudit(sql, auth.accountId, 'campaign.create', 'campaign', row.id, {
      event_id: input.value.eventId,
      purpose: input.value.purpose,
    });

    return jsonOk(
      {
        ok: true,
        campaign: {
          id: row.id,
          event_id: input.value.eventId,
          purpose: input.value.purpose,
          state: row.state,
          content_revision: row.content_revision,
          approved_revision: null,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

import { NextRequest } from 'next/server';
import type { Sql } from 'postgres';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { jsonError, jsonOk, readJsonBody, internalError } from '../../../../../lib/http';
import { recordAudit } from '../../../../../lib/audit';
import {
  campaignEditTransition,
  loadCampaignWithRole,
  validateCampaignEdit,
} from '../../../../../domain/campaigns';

type JsonParam = Parameters<Sql['json']>[0];

/**
 * PATCH /api/organizer/campaigns/[id] — edit purpose/body/audience filter.
 * Owner/admin only. AC-40: any content edit increments content_revision,
 * clears approved_revision and drops an 'approved' campaign back to 'draft'.
 * running/completed/cancelled campaigns are immutable (409).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { id } = await params;
    const body = await readJsonBody(req);
    const input = validateCampaignEdit(body);
    if (!input.ok) return jsonError(400, input.code, input.message);

    const sql = getSql();
    const loaded = await loadCampaignWithRole(sql, auth.accountId, id);
    if (!loaded) return jsonError(404, 'not_found', 'Campaign not found');
    if (loaded.role !== 'owner' && loaded.role !== 'admin') {
      // Cross-organizer members are 404 upstream (role null); in-organizer
      // staff is 403 — visible in audit, allowed to know they lack rights.
      return jsonError(403, 'forbidden', 'Only the organizer owner or admin can edit campaigns');
    }
    const { campaign } = loaded;

    const transition = campaignEditTransition(campaign.state, campaign.content_revision);
    if (!transition.allowed) {
      return jsonError(409, 'immutable_state', `A ${campaign.state} campaign cannot be edited`);
    }

    const purpose = input.value.purpose ?? campaign.purpose;
    const bodyText = input.value.bodyText ?? campaign.body_text;
    const audienceFilter = input.value.audienceFilter ?? campaign.audience_filter;

    const result = await sql.begin(async (tx) => {
      // CAS on revision: concurrent edits lose cleanly instead of double-bumping.
      const updated = await tx<{ id: string; state: string; content_revision: number; approved_revision: number | null }[]>`
        UPDATE campaigns
        SET purpose = ${purpose},
            body_text = ${bodyText},
            audience_filter = ${tx.json(audienceFilter as unknown as JsonParam)},
            content_revision = ${transition.nextRevision},
            approved_revision = ${transition.nextApprovedRevision},
            state = ${transition.nextState}
        WHERE id = ${campaign.id} AND content_revision = ${campaign.content_revision}
        RETURNING id, state, content_revision, approved_revision
      `;
      if (!updated[0]) return null;
      await recordAudit(tx, auth.accountId, 'campaign.edit', 'campaign', campaign.id, {
        content_revision: transition.nextRevision,
        approval_reset: campaign.approved_revision !== null,
      });
      return updated[0];
    });

    if (!result) return jsonError(409, 'concurrent_edit', 'Campaign changed concurrently; retry');
    return jsonOk({
      ok: true,
      campaign: {
        id: result.id,
        state: result.state,
        content_revision: result.content_revision,
        approved_revision: result.approved_revision,
      },
    });
  } catch (err) {
    return internalError(err);
  }
}

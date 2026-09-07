import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { jsonError, jsonOk, internalError } from '../../../../../../lib/http';
import { recordAudit } from '../../../../../../lib/audit';
import { currentEligibleAudience, loadCampaignWithRole } from '../../../../../../domain/campaigns';

/**
 * POST /api/organizer/campaigns/[id]/approve — OWNER ONLY (staff AND admin →
 * 403, AC-23). Freezes the currently eligible audience into campaign_audience
 * and pins approved_revision = content_revision. Editing afterwards resets
 * the approval (AC-40); sending re-validates the frozen snapshot against the
 * live consent/block/binding state (AC-41).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { id } = await params;
    const sql = getSql();
    const loaded = await loadCampaignWithRole(sql, auth.accountId, id);
    if (!loaded) return jsonError(404, 'not_found', 'Campaign not found');
    if (loaded.role === null) return jsonError(404, 'not_found', 'Campaign not found');
    // Explicit owner gate: admin is deliberately NOT enough for approval.
    if (loaded.role !== 'owner') {
      return jsonError(403, 'forbidden', 'Only the organizer owner can approve campaigns');
    }
    const { campaign } = loaded;
    if (campaign.state !== 'draft' && campaign.state !== 'approved') {
      return jsonError(409, 'invalid_state', `A ${campaign.state} campaign cannot be approved`);
    }
    if (!campaign.body_text) {
      return jsonError(409, 'invalid_state', 'Campaign has no message body');
    }

    const result = await sql.begin(async (tx) => {
      // Sender for block checks = the approving owner (the organizer persona).
      const audience = await currentEligibleAudience(tx, {
        eventId: campaign.event_id,
        purpose: campaign.purpose,
        senderAccountId: auth.accountId,
      });

      // Frozen snapshot: full replace on every approve.
      await tx`DELETE FROM campaign_audience WHERE campaign_id = ${campaign.id}`;
      for (const member of audience) {
        await tx`
          INSERT INTO campaign_audience (campaign_id, account_id, profile_id, channel)
          VALUES (${campaign.id}, ${member.account_id}, ${member.profile_id}, 'telegram')
        `;
      }

      const updated = await tx<{ id: string; state: string; content_revision: number; approved_revision: number }[]>`
        UPDATE campaigns
        SET state = 'approved', approved_revision = content_revision
        WHERE id = ${campaign.id}
          AND state IN ('draft', 'approved')
          AND content_revision = ${campaign.content_revision}
        RETURNING id, state, content_revision::int AS content_revision, approved_revision::int AS approved_revision
      `;
      if (!updated[0]) return null;
      await recordAudit(tx, auth.accountId, 'campaign.approve', 'campaign', campaign.id, {
        content_revision: campaign.content_revision,
        audience_count: audience.length,
      });
      return { campaign: updated[0], audienceCount: audience.length };
    });

    if (!result) return jsonError(409, 'concurrent_edit', 'Campaign changed concurrently; re-review and approve again');
    return jsonOk({
      ok: true,
      campaign: {
        id: result.campaign.id,
        state: result.campaign.state,
        content_revision: result.campaign.content_revision,
        approved_revision: result.campaign.approved_revision,
      },
      audience_count: result.audienceCount,
    });
  } catch (err) {
    return internalError(err);
  }
}

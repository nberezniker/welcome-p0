import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { internalError, jsonError, jsonOk, withApi } from '../../../../../../lib/http';
import { recordAudit } from '../../../../../../lib/audit';
import { canSend, currentEligibleAudience, loadCampaignWithRole } from '../../../../../../domain/campaigns';
import { enqueueOutbox } from '../../../../../../infra/outbox';

/**
 * POST /api/organizer/campaigns/[id]/send — enqueue one outbox job per
 * RECIPIENT whose snapshot membership is still valid RIGHT NOW (AC-41: the
 * frozen snapshot never bypasses a revoke — consent withdrawal, blocks or a
 * revoked binding between approve and send exclude the member here, and the
 * worker re-checks again at send time). Requires state='approved' AND
 * approved_revision=content_revision. Returns 202 {queued}; delivery counts
 * appear via /stats — provider acceptance is NEVER reported as 'delivered'.
 */
async function postRoute(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { id } = await params;
    const sql = getSql();
    const loaded = await loadCampaignWithRole(sql, auth.accountId, id);
    if (!loaded) return jsonError(404, 'not_found', 'Campaign not found');
    if (loaded.role === null) return jsonError(404, 'not_found', 'Campaign not found');
    if (loaded.role !== 'owner' && loaded.role !== 'admin') {
      return jsonError(403, 'forbidden', 'Only the organizer owner or admin can send campaigns');
    }
    const { campaign } = loaded;
    if (!canSend(campaign.state, campaign.content_revision, campaign.approved_revision)) {
      return jsonError(409, 'not_approved', 'Campaign must be approved with the current content revision before sending');
    }

    // Live re-validation of the frozen snapshot (AC-41).
    const stillEligible = await currentEligibleAudience(sql, {
      eventId: campaign.event_id,
      purpose: campaign.purpose,
      senderAccountId: auth.accountId,
    });
    const eligibleIds = new Set(stillEligible.map((m) => m.account_id));
    const snapshot = await sql<{ account_id: string }[]>`
      SELECT account_id FROM campaign_audience WHERE campaign_id = ${campaign.id}
    `;
    const recipients = snapshot.map((r) => r.account_id).filter((accountId) => eligibleIds.has(accountId));

    const queued = await sql.begin(async (tx) => {
      let created = 0;
      for (const accountId of recipients) {
        const res = await enqueueOutbox(tx, {
          dedupeKey: `campaign:${campaign.id}:${accountId}`,
          kind: 'campaign_message',
          subjectId: campaign.id,
          channel: 'telegram',
          purpose: campaign.purpose,
          payload: {
            account_id: accountId,
            text: campaign.body_text ?? '',
            campaign_id: campaign.id,
            enforce_consent: true,
            consent_scope: { type: 'event', id: campaign.event_id },
            counterparty_account_id: auth.accountId,
          },
        });
        if (res.created) created++;
      }
      await tx`
        UPDATE campaigns SET state = 'running', queued_count = queued_count + ${created}
        WHERE id = ${campaign.id}
      `;
      await recordAudit(tx, auth.accountId, 'campaign.send', 'campaign', campaign.id, {
        content_revision: campaign.content_revision,
        snapshot_size: snapshot.length,
        queued: created,
        excluded_by_revalidation: snapshot.length - recipients.length,
      });
      return created;
    });

    // 202 Accepted: the work is queued, not done.
    return jsonOk({ ok: true, campaign_id: campaign.id, queued, state: 'running' }, { status: 202 });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

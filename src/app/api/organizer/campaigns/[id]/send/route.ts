import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount, requireMfaFresh } from '../../../../../../lib/auth';
import { internalError, jsonError, jsonOk, withApi } from '../../../../../../lib/http';
import { recordAudit } from '../../../../../../lib/audit';
import {
  canSend,
  completeCampaignIfDrained,
  currentEligibleAudience,
  loadCampaignWithRole,
  normalizeAudienceFilter,
  type CampaignState,
} from '../../../../../../domain/campaigns';
import { enqueueOutbox } from '../../../../../../infra/outbox';

/**
 * POST /api/organizer/campaigns/[id]/send — enqueue one outbox job per
 * RECIPIENT whose snapshot membership is still valid RIGHT NOW (AC-41: the
 * frozen snapshot never bypasses a revoke — consent withdrawal, blocks or a
 * revoked binding between approve and send exclude the member here, and the
 * worker re-checks again at send time). Requires state='approved' AND
 * approved_revision=content_revision. F-03: for the ORGANIZER OWNER with a
 * confirmed MFA factor the session must be MFA-verified within 30 minutes
 * (step-up, ADR 0007) — 403 mfa_required otherwise; admins are exempt per
 * spec §9. Returns 202 {queued}; delivery counts appear via /stats — provider
 * acceptance is NEVER reported as 'delivered'.
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
    // F-03 step-up — owner actions only (admins exempt per spec §9).
    if (loaded.role === 'owner' && !(await requireMfaFresh(auth))) {
      return jsonError(403, 'mfa_required', 'Confirm your second factor to continue');
    }
    const { campaign } = loaded;
    if (!canSend(campaign.state, campaign.content_revision, campaign.approved_revision)) {
      return jsonError(409, 'not_approved', 'Campaign must be approved with the current content revision before sending');
    }

    // Live re-validation of the frozen snapshot (AC-41), with the campaign's
    // saved segment applied: consent, blocks, bindings AND the audience_filter
    // are all read from the live row at this moment, never from the snapshot.
    const stillEligible = await currentEligibleAudience(sql, {
      eventId: campaign.event_id,
      purpose: campaign.purpose,
      senderAccountId: auth.accountId,
      filter: normalizeAudienceFilter(campaign.audience_filter),
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
            // Event context for the send-time channel decision (ADR 0011): an
            // email fallback must come from THIS event's claimed registration.
            event_id: campaign.event_id,
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
      // A campaign with NO recipients is FINISHED, not running: every recipient it
      // has (none) has reached a terminal outcome. That is what happens whenever
      // the live revalidation above excludes the whole frozen snapshot, and it
      // used to leave the campaign 'running' permanently — immutable, unsendable
      // and unapprovable, i.e. parked in a state that describes work nobody is
      // doing. The helper is a no-op while `created > 0` (those jobs are pending),
      // so it is safe unconditionally, and it runs in the SAME transaction as the
      // send so the two cannot be observed apart.
      await completeCampaignIfDrained(tx, campaign.id);
      await recordAudit(tx, auth.accountId, 'campaign.send', 'campaign', campaign.id, {
        content_revision: campaign.content_revision,
        snapshot_size: snapshot.length,
        queued: created,
        excluded_by_revalidation: snapshot.length - recipients.length,
      });
      return created;
    });

    // The state the transaction actually left behind — 'completed' when nothing
    // was queued, 'running' when the worker now owns the work. Reporting a
    // hardcoded 'running' would contradict the row the caller is about to read.
    const [after] = await sql<{ state: CampaignState }[]>`
      SELECT state FROM campaigns WHERE id = ${campaign.id}
    `;

    // 202 Accepted: the work is queued, not done.
    return jsonOk({ ok: true, campaign_id: campaign.id, queued, state: after?.state ?? 'running' }, { status: 202 });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

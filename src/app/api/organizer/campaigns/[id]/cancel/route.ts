import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { internalError, jsonError, jsonOk, withApi } from '../../../../../../lib/http';
import { recordAudit } from '../../../../../../lib/audit';
import { campaignCancelTransition, loadCampaignWithRole } from '../../../../../../domain/campaigns';
import { suppressJobsForCampaign } from '../../../../../../infra/outbox';

/**
 * POST /api/organizer/campaigns/[id]/cancel — the STOP BUTTON.
 *
 * WHY IT EXISTS. `cancelled` was declared in the state union, the DB check, the UI
 * labels and the immutability guard, and no code path could reach it: an organizer
 * who approved a campaign by mistake had no way to stop the sends it was about to
 * queue. A tool that messages real people needs a way to stop messaging them.
 *
 * WHO. The same people who can start it: the organizer OWNER or an ADMIN of the
 * campaign's organizer (staff gets 403, like send). A stranger's campaign is 404 —
 * `loadCampaignWithRole` returns role=null for anyone outside the organizer and
 * this route treats that identically to "no such campaign", so a cancel attempt
 * cannot be used to probe which campaign ids exist.
 *
 * NO MFA STEP-UP, deliberately. Approve and send require a fresh second factor
 * because they make a message go OUT; cancelling makes messages STOP and cannot
 * reveal anything. Requiring step-up here would make the stop button fail in
 * exactly the situation it exists for (the organizer who realizes, mid-send, that
 * the content or the segment is wrong), and the state transition is fully audited
 * and reversible by nobody — a cancelled campaign cannot be resumed, which is the
 * point.
 *
 * WHAT IT DOES, in ONE transaction:
 *   1. `running → cancelled` (conditional update: a concurrent cancel or a
 *      completion loses cleanly instead of double-writing);
 *   2. suppresses the campaign's queued jobs — `pending` and `leased` only, each
 *      with a delivery_attempts row (code `campaign_cancelled`) so the
 *      suppression is visible rather than silent;
 *   3. writes ONE audit row for the transition, with the numbers it reports.
 *
 * WHAT IT DOES NOT DO, and says so in the response: it cannot recall a message a
 * channel has already accepted, and a job that was already inside a transport call
 * may still arrive. `suppressed` and `sent` are reported separately for exactly
 * that reason — the caller is told which of the two happened instead of being left
 * with "cancelled" as a single, flattering word.
 *
 * IDEMPOTENT: cancelling an already-cancelled campaign is a 200 no-op (no second
 * audit row, `suppressed: 0`), because a retried request or a double click is not
 * an error — see campaignCancelTransition. A campaign that is not `running` and
 * not `cancelled` is a 409 with its state named: nothing is queued in
 * draft/approved, and a completed campaign has nothing left to stop.
 */
async function postRoute(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { id } = await params;
    const sql = getSql();
    const loaded = await loadCampaignWithRole(sql, auth.accountId, id);
    if (!loaded) return jsonError(404, 'not_found', 'Campaign not found');
    // No membership at all is the same answer as no campaign: no existence leak.
    if (loaded.role === null) return jsonError(404, 'not_found', 'Campaign not found');
    if (loaded.role !== 'owner' && loaded.role !== 'admin') {
      return jsonError(403, 'forbidden', 'Only the organizer owner or admin can cancel campaigns');
    }

    const transition = campaignCancelTransition(loaded.campaign.state);
    if (transition.outcome === 'not_cancellable') {
      return jsonError(409, 'invalid_state', `A ${loaded.campaign.state} campaign cannot be cancelled`);
    }
    if (transition.outcome === 'already_cancelled') {
      // The outcome the caller asked for, already true. Reported, not repeated.
      return jsonOk({
        ok: true,
        campaign: { id: loaded.campaign.id, state: loaded.campaign.state },
        suppressed: 0,
        sent: loaded.campaign.sent_count,
        already_cancelled: true,
      });
    }

    const result = await sql.begin(async (tx) => {
      // Conditional transition: only the caller that moves the row out of
      // 'running' owns the suppression and the audit row below.
      const updated = await tx<{ id: string; sent_count: number; queued_count: number }[]>`
        UPDATE campaigns
        SET state = 'cancelled'
        WHERE id = ${loaded.campaign.id} AND state = 'running'
        RETURNING id, sent_count, queued_count
      `;
      if (!updated[0]) {
        // Someone else moved it first: read what actually happened and report
        // that, rather than writing a second transition over theirs.
        const [after] = await tx<{ state: string; sent_count: number }[]>`
          SELECT state, sent_count FROM campaigns WHERE id = ${loaded.campaign.id}
        `;
        if (after && after.state === 'cancelled') {
          return { already: true as const, sent: after.sent_count };
        }
        return { lost: true as const, state: after?.state ?? 'unknown' };
      }

      const suppressed = await suppressJobsForCampaign(tx, loaded.campaign.id, 'campaign_cancelled');
      await recordAudit(tx, auth.accountId, 'campaign.cancel', 'campaign', loaded.campaign.id, {
        suppressed: suppressed.length,
        sent: updated[0].sent_count,
        queued_count: updated[0].queued_count,
      });
      return { already: false as const, suppressed: suppressed.length, sent: updated[0].sent_count };
    });

    if ('lost' in result && result.lost) {
      return jsonError(409, 'invalid_state', `A ${result.state} campaign cannot be cancelled`);
    }
    if (result.already) {
      return jsonOk({
        ok: true,
        campaign: { id: loaded.campaign.id, state: 'cancelled' },
        suppressed: 0,
        sent: result.sent,
        already_cancelled: true,
      });
    }

    return jsonOk({
      ok: true,
      campaign: { id: loaded.campaign.id, state: 'cancelled' },
      suppressed: result.suppressed,
      sent: result.sent,
      already_cancelled: false,
    });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

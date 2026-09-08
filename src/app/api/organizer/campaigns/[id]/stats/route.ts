import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { privateCacheHeaders, jsonError, jsonOk, internalError } from '../../../../../../lib/http';
import { loadCampaignWithRole } from '../../../../../../domain/campaigns';
import { campaignJobStats, OUTBOX_STATUSES, type OutboxStatus } from '../../../../../../infra/outbox';

/**
 * GET /api/organizer/campaigns/[id]/stats — per-status outbox counters for one
 * campaign. 'sent' means the provider ACCEPTED the message (HTTP 200 from the
 * Bot API); it is NEVER reported as 'delivered' — actual recipient delivery is
 * not observable through the send API (spec S08).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { id } = await params;
    const sql = getSql();
    const loaded = await loadCampaignWithRole(sql, auth.accountId, id);
    if (!loaded) return jsonError(404, 'not_found', 'Campaign not found');
    if (loaded.role === null) return jsonError(404, 'not_found', 'Campaign not found');
    if (loaded.role !== 'owner' && loaded.role !== 'admin') {
      return jsonError(403, 'forbidden', 'Only the organizer owner or admin can view campaign stats');
    }

    const byStatus = await campaignJobStats(sql, loaded.campaign.id);
    const counters: Record<OutboxStatus, number> = {
      pending: 0, leased: 0, sent: 0, delivered: 0, failed: 0, unknown: 0, suppressed: 0, cancelled: 0,
    };
    for (const row of byStatus) counters[row.status] = row.count;

    // Suppression/failure reason codes (redacted delivery_attempts rows).
    const codes = await sql<{ code: string; state: string; count: number }[]>`
      SELECT da.code, da.state, count(*)::int AS count
      FROM delivery_attempts da
      JOIN outbox_jobs oj ON oj.id = da.job_id
      WHERE oj.kind = 'campaign_message' AND oj.payload->>'campaign_id' = ${loaded.campaign.id}
        AND da.code IS NOT NULL
      GROUP BY da.code, da.state
      ORDER BY count DESC
    `;

    return jsonOk(
      {
        ok: true,
        campaign_id: loaded.campaign.id,
        state: loaded.campaign.state,
        queued_total: loaded.campaign.queued_count,
        counters,
        outcome_codes: codes.map((c) => ({ state: c.state, code: c.code, count: c.count })),
        status_registry: OUTBOX_STATUSES,
        note: 'sent = provider accepted; delivered is never claimed from send acceptance',
      },
      { headers: privateCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

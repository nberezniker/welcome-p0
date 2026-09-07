import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { jsonError, jsonOk, internalError } from '../../../../../../lib/http';
import { currentEligibleAudience, loadCampaignWithRole } from '../../../../../../domain/campaigns';

/**
 * GET /api/organizer/campaigns/[id]/audience — live audience preview.
 * Returns the eligible COUNT and up to 20 sample display_names ONLY — never
 * contact values, never full recipient lists (spec S08: предварительный
 * подсчёт допустимых адресатов).
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
      return jsonError(403, 'forbidden', 'Only the organizer owner or admin can preview the audience');
    }

    const audience = await currentEligibleAudience(sql, {
      eventId: loaded.campaign.event_id,
      purpose: loaded.campaign.purpose,
      senderAccountId: auth.accountId,
    });
    const withChannel = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM event_memberships m
      JOIN profiles pr ON pr.id = m.profile_id
      JOIN channel_bindings cb ON cb.account_id = pr.account_id AND cb.provider = 'telegram' AND cb.state = 'active'
      WHERE m.event_id = ${loaded.campaign.event_id}
        AND m.state = 'active'
        AND pr.account_id = ANY(${audience.map((a) => a.account_id)})
    `;

    return jsonOk({
      ok: true,
      audience: {
        count: audience.length,
        channel_ready: withChannel[0]?.count ?? 0,
        sample: audience.slice(0, 20).map((a) => ({ display_name: a.display_name })),
      },
      snapshot_note: 'The binding audience snapshot is frozen at approve time and re-validated at send.',
    });
  } catch (err) {
    return internalError(err);
  }
}

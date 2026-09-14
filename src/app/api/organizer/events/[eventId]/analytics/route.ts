import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { internalError, jsonError, jsonOk, privateCacheHeaders } from '../../../../../../lib/http';
import { requireEventRole } from '../../../../../../domain/organizer';
import { loadEventAnalytics } from '../../../../../../domain/event-analytics';

/**
 * GET /api/organizer/events/[eventId]/analytics — event funnel aggregates.
 *
 * Owner/admin only: staff sees the event but not the aggregates, and a foreign
 * organizer sees nothing (403 — the event id is never confirmed to exist for a
 * caller without a role on it). The payload contains COUNTS for this event and
 * up to 30 days of daily counters; it never contains a participant, a contact
 * value, an introduction pair or a note.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { eventId } = await params;
    const sql = getSql();
    const role = await requireEventRole(sql, auth.accountId, eventId, ['owner', 'admin']);
    if (!role) {
      return jsonError(403, 'forbidden', 'Only the organizer owner or admin can read event analytics');
    }

    const analytics = await loadEventAnalytics(sql, role.eventId);
    return jsonOk(
      {
        ok: true,
        event_id: role.eventId,
        analytics,
        note: 'Aggregates only — no private content.',
      },
      { headers: privateCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { jsonError, internalError } from '../../../../../lib/http';
import { isUuid } from '../../../../../domain/organizer';
import { eventViewCacheHeaders } from '../../../../../lib/event-view';

export const dynamic = 'force-dynamic';

/** GET /api/events/[eventIdOrSlug]/directory — event directory for ACTIVE
 * members only. Strict field allowlist (display_name/headline/company/tags +
 * opaque profile_id for intro requests); no contacts, notes, emails, ids.
 * Blocks suppress visibility in BOTH directions. directory_close_at closes it. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventIdOrSlug: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { eventIdOrSlug } = await params;
    const sql = getSql();
    const byId = isUuid(eventIdOrSlug);
    const eventRows = await sql<{ id: string; directory_close_at: Date | null }[]>`
      SELECT id, directory_close_at FROM events
      WHERE ${byId ? sql`id = ${eventIdOrSlug}::uuid` : sql`slug = ${eventIdOrSlug}`}
      LIMIT 1
    `;
    const event = eventRows[0];
    if (!event) return jsonError(404, 'not_found', 'Event not found');

    const viewerRows = await sql<{ id: string }[]>`
      SELECT m.id
      FROM event_memberships m
      JOIN profiles p ON p.id = m.profile_id
      WHERE m.event_id = ${event.id} AND p.account_id = ${auth.accountId} AND m.state = 'active'
      LIMIT 1
    `;
    const viewer = viewerRows[0];
    if (!viewer) {
      return jsonError(403, 'forbidden', 'Only active members can see the event directory');
    }

    if (event.directory_close_at && new Date(event.directory_close_at).getTime() <= Date.now()) {
      return jsonError(403, 'directory_closed', 'The directory for this event is closed');
    }

    const members = await sql<{
      profile_id: string; display_name: string; headline: string | null;
      company: string | null; offer_tags: string[]; need_tags: string[];
    }[]>`
      SELECT pr.id AS profile_id, pr.display_name, pr.headline, pr.company,
             m.offer_tags, m.need_tags
      FROM event_memberships m
      JOIN profiles pr ON pr.id = m.profile_id
      JOIN accounts a ON a.id = pr.account_id
      WHERE m.event_id = ${event.id}
        AND m.state = 'active'
        AND m.directory_visible = true
        AND a.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_account_id = ${auth.accountId} AND b.target_account_id = a.id)
             OR (b.blocker_account_id = a.id AND b.target_account_id = ${auth.accountId})
        )
      ORDER BY pr.display_name ASC, pr.id ASC
    `;

    return NextResponse.json(
      { ok: true, members },
      { headers: eventViewCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

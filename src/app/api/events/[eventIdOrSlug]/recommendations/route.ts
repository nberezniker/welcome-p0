import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { privateCacheHeaders, jsonError, jsonOk, internalError } from '../../../../../lib/http';
import { isUuid } from '../../../../../domain/organizer';
import { recommendForEvent } from '../../../../../domain/recommendations';
import { LOCALE_COOKIE } from '../../../../../i18n';

export const dynamic = 'force-dynamic';

/** GET /api/events/[eventIdOrSlug]/recommendations — member-only.
 * An EMPTY list is a normal outcome, never an error. Only allowlisted fields
 * and fact-based reasons leave the server. */
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
    const eventRows = await sql<{ id: string }[]>`
      SELECT id FROM events
      WHERE ${byId ? sql`id = ${eventIdOrSlug}::uuid` : sql`slug = ${eventIdOrSlug}`}
      LIMIT 1
    `;
    const event = eventRows[0];
    if (!event) return jsonError(404, 'not_found', 'Event not found');

    const profileRows = await sql<{ id: string }[]>`
      SELECT p.id FROM profiles p WHERE p.account_id = ${auth.accountId} LIMIT 1
    `;
    const profile = profileRows[0];
    if (!profile) return jsonError(403, 'forbidden', 'Only event members can get recommendations');

    // The viewer can opt out of matching for this event.
    const viewerRows = await sql<{ matching_enabled: boolean; state: string }[]>`
      SELECT matching_enabled, state FROM event_memberships
      WHERE profile_id = ${profile.id} AND event_id = ${event.id} LIMIT 1
    `;
    const viewerMembership = viewerRows[0];
    if (!viewerMembership || viewerMembership.state !== 'active') {
      return jsonError(403, 'forbidden', 'Only active members can get recommendations');
    }
    if (!viewerMembership.matching_enabled) {
      return jsonOk({ ok: true, recommendations: [] }, { headers: privateCacheHeaders() });
    }

    const recommendations = await recommendForEvent(
      sql,
      { accountId: auth.accountId, profileId: profile.id },
      event.id,
      3,
      // Human reasons follow the viewer's UI language (ES falls back to EN).
      req.cookies.get(LOCALE_COOKIE)?.value === 'ru' ? 'ru' : 'en',
    );

    return jsonOk({ ok: true, recommendations }, { headers: privateCacheHeaders() });
  } catch (err) {
    return internalError(err);
  }
}

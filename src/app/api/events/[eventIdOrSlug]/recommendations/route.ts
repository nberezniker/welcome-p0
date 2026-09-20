import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { withRequestContext, privateCacheHeaders, jsonError, jsonOk, internalError } from '../../../../../lib/http';
import { isUuid } from '../../../../../domain/organizer';
import { recommendForEvent } from '../../../../../domain/recommendations';
import { DEFAULT_RECOMMENDATION_MODE, isRecommendationMode } from '../../../../../domain/networking-score';

export const dynamic = 'force-dynamic';

/**
 * GET /api/events/[eventIdOrSlug]/recommendations?mode=useful|grow|similar|explore
 * — member-only. `mode` defaults to `useful` (matching v4 §B4); an unknown value
 * is a 400 rather than a silent fallback, because a client that asked for
 * "similar" and silently got "useful" would have no way to notice.
 *
 * The response echoes `mode` and carries `excluded_reason` (`null` whenever the
 * list is non-empty) so the UI can say WHY it is short instead of showing an
 * empty box. An EMPTY list is a normal outcome, never an error. Only allowlisted
 * fields leave the server; reasons are STRUCTURAL (code + catalogue ids) and the
 * UI renders them in the viewer's language (src/domain/reasons.ts,
 * src/domain/reasons-v4.ts).
 */
/* Request scope only — a read-only GET takes no CSRF/rate-limit guard, but its
 * error bodies and log lines must still carry the request's correlation id. */
export const GET = withRequestContext(get);

async function get(
  req: NextRequest,
  { params }: { params: Promise<{ eventIdOrSlug: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const rawMode = req.nextUrl.searchParams.get('mode');
    if (rawMode !== null && !isRecommendationMode(rawMode)) {
      return jsonError(400, 'invalid_mode', `mode must be one of: useful, grow, similar, explore`);
    }
    const mode = rawMode === null ? DEFAULT_RECOMMENDATION_MODE : rawMode;

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
      return jsonOk(
        { ok: true, mode, recommendations: [], excluded_count: 0, excluded_reason: null },
        { headers: privateCacheHeaders() },
      );
    }

    const result = await recommendForEvent(
      sql,
      { accountId: auth.accountId, profileId: profile.id },
      event.id,
      3,
      mode,
    );

    return jsonOk(
      {
        ok: true,
        mode: result.mode,
        recommendations: result.items,
        excluded_count: result.excluded_count,
        excluded_reason: result.excluded_reason,
      },
      { headers: privateCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

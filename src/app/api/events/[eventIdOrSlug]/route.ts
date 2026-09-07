import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { jsonError, internalError } from '../../../../lib/http';
import { loadEventView, eventViewCacheHeaders } from '../../../../lib/event-view';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** GET /api/events/[eventIdOrSlug] — public event projection.
 * online_link is included ONLY when the viewer is an active member. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventIdOrSlug: string }> },
) {
  try {
    const { eventIdOrSlug } = await params;
    const auth = await requireAccount(req);
    const view = await loadEventView(getSql(), eventIdOrSlug, auth?.accountId ?? null);
    if (!view) {
      return jsonError(404, 'not_found', 'Event not found', { headers: eventViewCacheHeaders() });
    }
    return NextResponse.json(
      { ok: true, event: view.event, viewer: view.viewer },
      { headers: eventViewCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

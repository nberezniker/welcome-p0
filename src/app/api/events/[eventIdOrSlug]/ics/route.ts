import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { loadEventView, eventViewCacheHeaders } from '../../../../../lib/event-view';
import { buildIcs, icsFilename } from '../../../../../domain/ics';
import { appBaseUrl } from '../../../../../lib/env';
import { jsonError, internalError } from '../../../../../lib/http';

export const dynamic = 'force-dynamic';

/**
 * GET /api/events/[eventIdOrSlug]/ics — the event as a calendar file.
 *
 * Access is exactly the event page's: anyone who can open /e/<slug> can
 * download it. That is also why the view is loaded WITHOUT a viewer — with no
 * viewer there is no `online_link` to accidentally carry into a file that
 * outlives every membership check (see src/domain/ics.ts).
 *
 * 404 when the event does not exist, 409 when it has no schedule yet: a
 * calendar file without a start time is worse than an honest error, because the
 * client would import it as "now".
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventIdOrSlug: string }> },
) {
  try {
    const { eventIdOrSlug } = await params;
    const view = await loadEventView(getSql(), eventIdOrSlug, null);
    if (!view) {
      return jsonError(404, 'not_found', 'Event not found', { headers: eventViewCacheHeaders() });
    }
    const { event } = view;
    if (!event.starts_at) {
      return jsonError(409, 'no_schedule', 'This event has no start time yet', {
        headers: eventViewCacheHeaders(),
      });
    }

    // APP_BASE_URL first: a stable UID must not change between the production
    // host and a preview deployment, or every download adds a calendar entry.
    const host = safeHost(appBaseUrl()) ?? req.nextUrl.host;
    const body = buildIcs({
      id: event.id,
      host,
      name: event.name,
      description: event.description,
      consentText: event.consent_text,
      locationLabel: event.location_label,
      startsAt: new Date(event.starts_at),
      endsAt: event.ends_at ? new Date(event.ends_at) : null,
      timezone: event.timezone,
      url: `${appBaseUrl().replace(/\/+$/, '')}/e/${event.slug}`,
    });

    return new NextResponse(body, {
      status: 200,
      headers: {
        // Not cacheable: the schedule can change, and a cached .ics would pin a
        // stale time in someone's calendar. Same discipline as the event page.
        ...eventViewCacheHeaders(),
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${icsFilename(event.slug)}"`,
      },
    });
  } catch (err) {
    return internalError(err);
  }
}

/** Host of a configured base URL, or null when it cannot be parsed. */
function safeHost(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).host;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

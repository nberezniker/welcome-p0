import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';
import { getLocale } from '../../../i18n';
import { getSql } from '../../../lib/db';
import { appBaseUrl } from '../../../lib/env';
import { loadEventView } from '../../../lib/event-view';
import { formatEventWhen } from '../../../lib/event-time';
import { OG_IMAGE_SIZE, eventCardMarkup, hostFromBaseUrl } from '../../../lib/og-card';

/**
 * Share preview of an event page (/e/[slug]).
 *
 * The projection is loaded with NO viewer, which is what makes this image safe:
 * `loadEventView` resolves `online_link` only for an active member, so an
 * anonymous render can never receive the room link — and the card builder has no
 * slot for it anyway. Only the fields the public page itself shows are rendered
 * here: title, schedule, place.
 */

export const alt = 'WELCOME event preview';
export const size = OG_IMAGE_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Same localisation path as the page, so the preview and the page agree.
  const locale = await getLocale();
  const view = await loadEventView(getSql(), slug, null);
  if (!view) notFound();

  const { event } = view;
  return new ImageResponse(
    eventCardMarkup({
      title: event.name,
      when: formatEventWhen(
        event.starts_at ? new Date(event.starts_at) : null,
        event.ends_at ? new Date(event.ends_at) : null,
        event.timezone,
        locale,
      ),
      place: event.location_label,
      host: hostFromBaseUrl(appBaseUrl()),
    }),
    OG_IMAGE_SIZE,
  );
}

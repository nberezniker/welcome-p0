import { ImageResponse } from 'next/og';
import { notFound } from 'next/navigation';
import { appBaseUrl } from '../../../lib/env';
import { OG_IMAGE_SIZE, hostFromBaseUrl, personCardMarkup } from '../../../lib/og-card';
import { loadPublicProfile } from '../../../lib/public-profile';

/**
 * Share preview of a public card (/p/[slug]): the card is meant to be pasted
 * into a chat, so the preview image is the first thing the other side sees.
 *
 * The content comes from `loadPublicProfile` — the same public projection the
 * page renders, which is the single place that decides what may be shown (hidden
 * fields arrive empty, only public contacts are present at all). The card
 * builder then reads just the name, headline and company, so nothing else can
 * appear here.
 */

// Read by Next as the image's alt text; non-empty on purpose — an og:image
// without alt is a broken preview for screen readers and link unfurlers alike.
export const alt = 'WELCOME public card preview';
export const size = OG_IMAGE_SIZE;
export const contentType = 'image/png';
// Per-slug images are rendered on demand, never prerendered at build time.
export const dynamic = 'force-dynamic';

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const profile = await loadPublicProfile(slug);
  // Same answer as the page for a missing *or* unpublished card: the preview
  // must not become an oracle for which slugs exist.
  if (!profile) notFound();

  return new ImageResponse(
    personCardMarkup({
      displayName: profile.display_name,
      headline: profile.headline,
      company: profile.company,
      host: hostFromBaseUrl(appBaseUrl()),
    }),
    OG_IMAGE_SIZE,
  );
}

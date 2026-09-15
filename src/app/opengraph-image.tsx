import { ImageResponse } from 'next/og';
import { getT } from '../i18n';
import { appBaseUrl } from '../lib/env';
import { OG_IMAGE_SIZE, hostFromBaseUrl, landingCardMarkup } from '../lib/og-card';

/**
 * Share preview of the marketing landing (/).
 *
 * This is the page people paste into a chat, so the image is the first thing the
 * other side sees — and until now there was none. The two strings it renders are
 * the ones the page's own metadata advertises (src/lib/share-meta.ts), read from
 * the same dictionary in the same locale (getT, i.e. `?lang=` → cookie →
 * English), so the picture and the unfurl cannot drift apart. Nothing else has a
 * slot on the card: no traction number, no logo wall, no benchmark (spec §7).
 *
 * The file convention also makes this the default preview for the routes that
 * declare none of their own (sign-in, legal); /p and /e keep their own cards.
 */

// Read by Next as the image's alt text; non-empty on purpose — an og:image
// without alt is a broken preview for screen readers and link unfurlers alike.
export const alt = 'WELCOME landing preview';
export const size = OG_IMAGE_SIZE;
export const contentType = 'image/png';
// The card is localized, so it is rendered per request rather than baked at
// build time (the same reason the event card route is dynamic).
export const dynamic = 'force-dynamic';

export default async function Image() {
  const { t } = await getT();
  return new ImageResponse(
    landingCardMarkup({
      headline: t('landing.metaTitle'),
      body: t('landing.metaDescription'),
      host: hostFromBaseUrl(appBaseUrl()),
    }),
    OG_IMAGE_SIZE,
  );
}

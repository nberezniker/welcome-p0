import type { Metadata } from 'next';

/**
 * Share (Open Graph / Twitter) metadata for the marketing landing (/) — the one
 * page whose whole job is to be pasted into a chat.
 *
 * Two properties this module exists to keep:
 *
 * 1. ONE SOURCE FOR THE LINK AND THE IMAGE. src/app/opengraph-image.tsx renders
 *    the very same two strings, so the picture and the unfurl text can never
 *    disagree about what the product promises.
 *
 * 2. NOTHING EMPTY, NOTHING INVENTED. A missing og:title is the defect this
 *    fixes; a literal `{name}` is the same defect wearing a hat — a dictionary
 *    value that never got interpolated ships as visible text to every chat
 *    client. Both throw here, at the single point where the strings become
 *    metadata, rather than being silently published. Neither is reachable from
 *    the dictionaries as they stand (every key is non-empty, and the two landing
 *    share keys take no variables), so a failure here means someone edited the
 *    copy into a broken state — which is exactly when it should stop.
 */

/** The strings a landing share advertises. Both are dictionary values. */
export interface ShareCopy {
  readonly title: string;
  readonly description: string;
}

/** Brand shown as og:site_name next to the title in a chat unfurl. */
export const SITE_NAME = 'WELCOME';

const PLACEHOLDER = /\{[a-zA-Z0-9_]+\}/;

/** Collapses whitespace and refuses to publish a blank or uninterpolated value. */
function requireShareText(value: string, field: string): string {
  const flat = value.trim().replace(/\s+/g, ' ');
  if (flat.length === 0) {
    throw new Error(`share metadata: ${field} is empty`);
  }
  if (PLACEHOLDER.test(flat)) {
    throw new Error(`share metadata: ${field} still contains an uninterpolated placeholder: ${flat}`);
  }
  return flat;
}

/**
 * Absolute URL for a path on the site, derived from `appBaseUrl()` (src/lib/env.ts).
 *
 * Trailing slashes are dropped before joining so a configured base of
 * `https://host/` does not turn into `https://host//e/slug`; the root path keeps
 * its single slash, because that is the URL a person actually shares.
 */
export function canonicalUrl(baseUrl: string, path: string): string {
  const origin = baseUrl.replace(/\/+$/, '');
  if (path === '' || path === '/') return `${origin}/`;
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The landing page's metadata: title, description, canonical URL and the
 * share tags a chat client reads. The image itself is added by the Next file
 * convention (src/app/opengraph-image.tsx), which is why nothing here names one.
 */
export function landingShareMetadata(copy: ShareCopy, baseUrl: string): Metadata {
  const title = requireShareText(copy.title, 'title');
  const description = requireShareText(copy.description, 'description');
  const url = canonicalUrl(baseUrl, '/');

  return {
    // The tab/SEO title carries the brand; the unfurl title does not, because
    // og:site_name already prints "WELCOME" beside it and the preview image
    // renders this same string under its own wordmark. `absolute` is deliberate:
    // the root layout's "%s · WELCOME" template does not reach a page in its own
    // segment today, and it must not start doubling the brand if that changes.
    title: { absolute: `${title} · ${SITE_NAME}` },
    description,
    robots: { index: true, follow: true },
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

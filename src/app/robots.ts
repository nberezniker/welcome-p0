import type { MetadataRoute } from 'next';
import { appBaseUrl } from '../lib/env';
import { canonicalUrl } from '../lib/share-meta';

/**
 * /robots.txt (Next metadata-route convention: this file IS the route).
 *
 * Three areas are closed to crawlers, and they are closed for the same reason:
 * every page under them is either somebody's private cabinet, an organizer tool
 * that requires a role, or a JSON endpoint — none of it is a page a stranger
 * should arrive on from a search result.
 *
 * The rules are PREFIX matches (RFC 9309 §2.2.2), and the requested prefixes
 * carry their trailing slash, so the bare `/me` and `/organizer` are not
 * matched by them. That gap is harmless here rather than merely untidy: both
 * pages gate on a session server-side (src/lib/requireAccountId), so an
 * anonymous crawler that asks for `/me` is answered with a redirect to /login —
 * a public page — and never with someone's data.
 *
 * The `Sitemap:` line is an absolute URL, and it is built from the SAME
 * `appBaseUrl()` + `canonicalUrl()` pair the page metadata uses
 * (src/app/layout.tsx, src/lib/share-meta.ts) rather than from a literal host.
 * That is what makes this file correct for a fork: a self-hoster who sets
 * APP_BASE_URL to their own domain gets THEIR sitemap URL, and the upstream
 * author's domain appears nowhere in the repository.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/me/', '/organizer/', '/api/'],
      },
    ],
    sitemap: canonicalUrl(appBaseUrl(), '/sitemap.xml'),
  };
}

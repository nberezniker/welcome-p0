import type { MetadataRoute } from 'next';
import { appBaseUrl } from '../lib/env';
import { canonicalUrl } from '../lib/share-meta';

/**
 * /sitemap.xml — the PUBLIC pages, and nothing else.
 *
 * Exactly three URLs, and each one hand-picked rather than derived from the
 * route tree:
 *   /                 the landing page;
 *   /legal/privacy    a policy every visitor can read without an account;
 *   /legal/terms      the same for the terms.
 *
 * What is deliberately absent, and why it must stay absent:
 *   /p/<slug>   a personal card. Reachable only by someone the owner gave the
 *               link or the QR to, and `noindex` by contract — listing one here
 *               would turn a business card into a search result.
 *   /e/<slug>   an event page, visible to its own audience.
 *   /me/*, /organizer/*, /api/* — closed in /robots.txt for the same reason.
 * A sitemap that advertises a page the product promises not to expose is worse
 * than no sitemap: it is the product contradicting itself.
 *
 * No `lastModified` is emitted. It is optional, and a build timestamp would be
 * a claim that these pages changed at deploy time — a lie a crawler acts on.
 * Nothing here is invented: every URL is built from `appBaseUrl()` through the
 * same `canonicalUrl()` helper the page metadata uses, so a fork advertises its
 * own origin and never the upstream author's domain.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = appBaseUrl();
  return ['/', '/legal/privacy', '/legal/terms'].map((path) => ({
    url: canonicalUrl(baseUrl, path),
  }));
}

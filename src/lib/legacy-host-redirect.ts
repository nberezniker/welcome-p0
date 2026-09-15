import type { NextConfig } from 'next';

/**
 * Legacy-host → canonical-domain redirect rules for `next.config.ts`.
 *
 * The app has been served from two Vercel hosts (`welcome-p0-nikiti4.vercel.app`
 * was the first production host, later `welcome-p0.vercel.app`). Printed QR
 * codes and links shared before the custom domain existed still point at them,
 * so those requests must keep working — but they must land on the canonical site
 * now that it exists.
 *
 * The rules live in this module rather than inline in the config so they can be
 * asserted without booting a server (tests/unit/legacy-host-redirect.test.ts),
 * and so the exceptions below have one home.
 */

/** Where the site canonically lives (`APP_BASE_URL` in production). */
export const CANONICAL_ORIGIN = 'https://welcome.colmogravity.net';

/** The exact legacy hosts, never a wildcard: every other *.vercel.app host is a
 * preview deployment and must stay reachable on its own URL. */
export const LEGACY_HOSTS: readonly string[] = ['welcome-p0-nikiti4.vercel.app', 'welcome-p0.vercel.app'];

/**
 * Path prefix that stays ON the legacy host. `/api/health` is what an uptime
 * checker or a deploy smoke test calls, and API clients are configured against
 * an origin — redirecting a POST/PUT would silently turn it into a GET on the
 * canonical host, or break a client that does not follow 308. Only page
 * navigation is redirected.
 */
export const LEGACY_SERVED_PREFIX = 'api';

/**
 * Redirect `source` for page paths. Next matches `source` with path-to-regexp,
 * so the negative lookahead is the one place `/api` (and `/api` itself, not just
 * `/api/…`) is carved out. The `.*` allows the empty path, which is what keeps a
 * bare legacy-host request (`/`) redirecting too.
 */
export const LEGACY_REDIRECT_SOURCE = `/:path((?!${LEGACY_SERVED_PREFIX}(?:/|$)).*)`;

type RedirectsResult = Awaited<ReturnType<NonNullable<NextConfig['redirects']>>>;
export type RedirectRule = NonNullable<RedirectsResult>[number];

/**
 * Escapes a host so Next matches it exactly.
 *
 * Next compiles a `has: [{ type: 'host' }]` value as `new RegExp('^' + value +
 * '$')` — anchored, but with regex metacharacters UNESCAPED (next's
 * shared/lib/router/utils/prepare-destination.ts). A bare `welcome-p0.vercel.app`
 * would therefore also match `welcome-p0xvercel-yapp`, i.e. a host nobody
 * approved. Escaping the dots (and any other metacharacter) pins one rule to one
 * exact host. The comparison itself is case-insensitive and port-insensitive:
 * Next lowercases the Host header and strips its port before matching.
 */
export function exactHostPattern(host: string): string {
  return host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The two redirect rules, one per legacy host, path and query preserved. */
export function legacyHostRedirects(): RedirectRule[] {
  return LEGACY_HOSTS.map((host) => ({
    source: LEGACY_REDIRECT_SOURCE,
    has: [{ type: 'host', value: exactHostPattern(host) }],
    // `:path` carries the original path; Next merges the incoming query string
    // into the destination on its own (the destination declares none).
    destination: `${CANONICAL_ORIGIN}/:path`,
    // permanent: true → 308 Permanent Redirect, which preserves the method.
    permanent: true,
  }));
}

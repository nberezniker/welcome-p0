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
 *
 * SELF-HOSTING NOTE. Both halves are deployment configuration, not project
 * facts, because the hosts and the domain below belong to the ORIGINAL
 * deployment: a clone that runs this code is nobody's successor and must not
 * send its visitors to somebody else's site.
 *
 *   - `CANONICAL_ORIGIN` — the redirect destination. Defaults to `APP_BASE_URL`
 *     (the deployment's own public origin); only when neither is set does it
 *     fall back to the historical release domain below.
 *   - `LEGACY_REDIRECT_HOSTS` — comma-separated host list to redirect FROM.
 *     Defaults to the two historical Vercel hosts.
 *   - `LEGACY_REDIRECTS=off` — drop the rules entirely. The documented setting
 *     for a deployment that never owned those hosts (see SELF_HOSTING.md).
 */

/**
 * The historical release domain: where the author's deployment lives. It is a
 * DEFAULT, never a requirement — a clone that sets `APP_BASE_URL` (which every
 * deployment does) redirects to its own origin instead, and `LEGACY_REDIRECTS=off`
 * removes the rules altogether.
 */
export const DEFAULT_CANONICAL_ORIGIN = 'https://welcome.colmogravity.net';

/** The exact legacy hosts of the original deployment, never a wildcard: every
 * other *.vercel.app host is a preview deployment and must stay reachable on its
 * own URL. Overridable with `LEGACY_REDIRECT_HOSTS`. */
export const DEFAULT_LEGACY_HOSTS: readonly string[] = [
  'welcome-p0-nikiti4.vercel.app',
  'welcome-p0.vercel.app',
];

/** Back-compat aliases: the defaults, for callers that mean "the release setup". */
export const CANONICAL_ORIGIN = DEFAULT_CANONICAL_ORIGIN;
export const LEGACY_HOSTS = DEFAULT_LEGACY_HOSTS;

/**
 * The env this module reads; a parameter so tests can drive both branches.
 * A plain string map (the same shape the transports take) so `process.env` can
 * be passed straight in. Names read: `CANONICAL_ORIGIN`, `APP_BASE_URL`,
 * `LEGACY_REDIRECT_HOSTS`, `LEGACY_REDIRECTS`.
 */
export type RedirectEnv = Record<string, string | undefined>;

/** `origin` without a trailing slash, or null when unusable. */
function normaliseOrigin(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (value.length === 0) return null;
  try {
    new URL(value);
    return value;
  } catch {
    return null;
  }
}

/**
 * Where legacy hosts are sent. `CANONICAL_ORIGIN` wins; otherwise the
 * deployment's own `APP_BASE_URL`; otherwise the historical release domain. An
 * unparsable value falls through rather than producing a broken `destination`.
 */
export function canonicalOrigin(env: RedirectEnv = process.env): string {
  return (
    normaliseOrigin(env.CANONICAL_ORIGIN) ??
    normaliseOrigin(env.APP_BASE_URL) ??
    DEFAULT_CANONICAL_ORIGIN
  );
}

/** The hosts to redirect from, in rule order. `LEGACY_REDIRECT_HOSTS` is a CSV. */
export function legacyHosts(env: RedirectEnv = process.env): readonly string[] {
  const raw = env.LEGACY_REDIRECT_HOSTS;
  if (raw === undefined) return DEFAULT_LEGACY_HOSTS;
  return raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
}

/** `LEGACY_REDIRECTS=off` (case-insensitive) turns the whole feature off. */
export function legacyRedirectsEnabled(env: RedirectEnv = process.env): boolean {
  return (env.LEGACY_REDIRECTS ?? '').trim().toLowerCase() !== 'off';
}

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

/**
 * One redirect rule per configured legacy host, path and query preserved.
 *
 * Empty when `LEGACY_REDIRECTS=off` or when `LEGACY_REDIRECT_HOSTS` is set to an
 * empty string — the honest outcome for a deployment that never owned a legacy
 * host: no rule rather than a rule pointing somewhere it does not control.
 */
export function legacyHostRedirects(env: RedirectEnv = process.env): RedirectRule[] {
  if (!legacyRedirectsEnabled(env)) return [];
  const destination = canonicalOrigin(env);
  return legacyHosts(env).map((host) => ({
    source: LEGACY_REDIRECT_SOURCE,
    has: [{ type: 'host', value: exactHostPattern(host) }],
    // `:path` carries the original path; Next merges the incoming query string
    // into the destination on its own (the destination declares none).
    destination: `${destination}/:path`,
    // permanent: true → 308 Permanent Redirect, which preserves the method.
    permanent: true,
  }));
}

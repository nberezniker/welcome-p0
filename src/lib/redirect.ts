/**
 * Safe in-app redirect target validation (F-10).
 * A `?next=` value is only usable when it is a LOCAL path:
 *   - starts with a single '/';
 *   - NOT protocol-relative ('//evil.com');
 *   - NEVER contains a backslash — the WHATWG URL parser treats '\' as '/',
 *     so '/\evil.com' navigates off-site in browsers.
 * Returns null for anything else (the caller falls back to a fixed path).
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\')) return null;
  return value;
}

/**
 * A 302 whose `Location` is a LOCAL path, built from our own constants only.
 *
 * Used by the OAuth flow (src/app/api/oauth/google/*) to send the browser back to
 * /me/connections with a status word. Relative on purpose, for two reasons:
 *
 *   1. `NextResponse.redirect` demands an ABSOLUTE url, and the only absolute
 *      origins available here are `APP_BASE_URL` (which may be unset or wrong — a
 *      misconfigured deployment would then bounce users to localhost) or the
 *      request's `Host` header (which a caller controls, so trusting it turns this
 *      route into an open redirect). A relative reference has neither problem: the
 *      browser resolves it against the URL it actually asked for, and RFC 7231
 *      allows it.
 *   2. The path is a constant and the query is built from a fixed set of words, so
 *      nothing user-supplied can end up in the Location header.
 *
 * `params` are URL-encoded here, and the caller passes literal values, not input.
 */
export function localRedirectResponse(
  path: string,
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
): Response {
  const safePath = safeNextPath(path) ?? '/';
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: query.length > 0 ? `${safePath}?${query}` : safePath,
      ...headers,
    },
  });
}

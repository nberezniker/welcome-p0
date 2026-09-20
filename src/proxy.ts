import { NextRequest, NextResponse } from 'next/server';
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_QUERY_PARAM,
  isLocale,
} from './i18n/locale';
import { REQUEST_ID_HEADER, isWellFormedRequestId, newRequestId } from './lib/request-id';

/**
 * Two per-request concerns, one place, because Next gives a deployment exactly
 * one proxy hook.
 *
 * 1. LOCALE OVERRIDE for the PUBLIC pages: `?lang=en|ru|es`.
 *
 * File convention: Next 16 renamed the `middleware` convention to `proxy`
 * (src/proxy.ts, handler exported as `proxy`); the old name only warns, but a
 * clean build log matters and the new convention is what this repo targets.
 *
 * The previous mechanism (2026-09-14 usage-matrix, deviation R1) was the
 * `welcome_locale` cookie only, set by a client-side POST — so a shared link
 * could not carry a language and a crawler/no-JS visitor always got English.
 *
 * Both documented behaviours are implemented here, in one place, because the
 * cookie can only be written on a RESPONSE while the layout must already render
 * the requested language in the SAME request:
 *   1. the current render — the forwarded request headers carry both the
 *      rewritten Cookie header and `x-welcome-locale`, which getLocale()
 *      (src/i18n/index.ts) reads before the cookie;
 *   2. the next visit — the Set-Cookie on the response.
 * An invalid value (`?lang=de`, `?lang=RU`, empty) is ignored completely: no
 * cookie is written and the stored preference is untouched.
 *
 * Scope is deliberately the four public entry points named by the brief. Signed
 * -in surfaces keep the cookie-only switcher (an explicit UI action), so a
 * stray query parameter cannot silently change a session's language.
 *
 * 2. REQUEST ID for every `/api` request (matcher below).
 *
 * WHY HERE. The id has to exist BEFORE any handler runs, and it has to be the
 * SAME value for a request that a route, its error body and its log lines all
 * see. Normalising it at the edge of the app is what makes that structural: a
 * well-formed inbound `x-request-id` (a caller's, an upstream proxy's) is kept,
 * and anything else — absent, truncated, oversized, or carrying characters that
 * would forge a line in the human log format — is REPLACED, never echoed. A
 * route therefore reads the header and gets a value that is already safe to log
 * and return; `requestIdFor` (src/lib/request-context.ts) applies the identical
 * rule for the paths the proxy does not cover.
 *
 * This runs in the edge runtime, which is why the id helpers live in
 * src/lib/request-id.ts (global Web Crypto, no Node built-ins) rather than in a
 * module that reaches for `node:crypto`.
 *
 * `secure` mirrors isProduction() in src/lib/env.ts; that module is not
 * imported here because it pulls in node:crypto (not edge-compatible).
 */
export function proxy(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get(LOCALE_QUERY_PARAM);
  const localeApplied = isLocale(requested);
  if (localeApplied) {
    // 1a. Cookie rewrite for the current render. RequestCookies writes through
    //     to the underlying request headers, which is why the snapshot below is
    //     taken AFTER this line and not before: the forwarded copy is what the
    //     current render reads, and taking it first would forward the OLD cookie
    //     and make `?lang=` a next-visit-only setting again.
    request.cookies.set(LOCALE_COOKIE, requested);
  }

  const requestHeaders = new Headers(request.headers);
  let mutated = false;

  if (localeApplied) {
    // 1b. Explicit per-request header: the resolution channel getLocale() reads
    //     first, so the override survives even if the header rewrite above is
    //     ever re-implemented by Next.
    requestHeaders.set('x-welcome-locale', requested);
    mutated = true;
  }

  const incomingId = request.headers.get(REQUEST_ID_HEADER);
  if (!isWellFormedRequestId(incomingId)) {
    requestHeaders.set(REQUEST_ID_HEADER, newRequestId());
    mutated = true;
  }

  // Nothing changed → hand the request on untouched. Returning a rewritten
  // header set on every matched request would be a (small) behaviour change for
  // the pages this proxy served before the id existed, for no gain: a
  // well-formed inbound id is already readable by the route as-is.
  if (!mutated) return NextResponse.next();

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  // 2. Remember the choice for the next visit (same attributes as
  //    POST /api/locale).
  if (localeApplied) {
    response.cookies.set({
      name: LOCALE_COOKIE,
      value: requested,
      path: '/',
      maxAge: LOCALE_COOKIE_MAX_AGE,
      sameSite: 'lax',
      secure: process.env.APP_ENV === 'production',
    });
  }
  return response;
}

export const config = {
  // `/api/:path*` is here for the request id alone — the locale override above
  // is still scoped to the four public entry points by its own guard.
  matcher: ['/', '/login', '/p/:path*', '/legal/:path*', '/api/:path*'],
};

import { NextRequest, NextResponse } from 'next/server';
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_QUERY_PARAM,
  isLocale,
} from './i18n/locale';

/**
 * Locale override for the PUBLIC pages: `?lang=en|ru|es`.
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
 * `secure` mirrors isProduction() in src/lib/env.ts; that module is not
 * imported here because it pulls in node:crypto (not edge-compatible).
 */
export function proxy(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get(LOCALE_QUERY_PARAM);
  if (!isLocale(requested)) return NextResponse.next();

  // 1a. Cookie rewrite for the current render (RequestCookies writes through to
  //     the underlying request headers).
  request.cookies.set(LOCALE_COOKIE, requested);
  // 1b. Explicit per-request header: the resolution channel getLocale() reads
  //     first, so the override survives even if the header rewrite above is
  //     ever re-implemented by Next.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-welcome-locale', requested);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  // 2. Remember the choice for the next visit (same attributes as
  //    POST /api/locale).
  response.cookies.set({
    name: LOCALE_COOKIE,
    value: requested,
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: process.env.APP_ENV === 'production',
  });
  return response;
}

export const config = {
  matcher: ['/', '/login', '/p/:path*', '/legal/:path*'],
};

import { NextRequest, NextResponse } from 'next/server';
import { internalError, jsonError, readJsonBody, withApi } from '../../../lib/http';
import { isProduction } from '../../../lib/env';
import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from '../../../i18n';

/**
 * POST /api/locale { "locale": "en" | "ru" | "es" } — sets the locale cookie.
 * The only new product endpoint added in Phase 4 (per the phase brief).
 * Cookie-based locale: documented in src/i18n/README.md.
 */
async function postRoute(req: NextRequest) {
  try {
    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const raw = body?.['locale'];
    if (!isLocale(raw)) {
      return jsonError(400, 'invalid_locale', 'locale must be one of: en, ru, es');
    }
    const locale: Locale = raw;
    const res = NextResponse.json({ ok: true, locale });
    res.cookies.set({
      name: LOCALE_COOKIE,
      value: locale,
      path: '/',
      maxAge: LOCALE_COOKIE_MAX_AGE,
      sameSite: 'lax',
      secure: isProduction(),
    });
    return res;
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

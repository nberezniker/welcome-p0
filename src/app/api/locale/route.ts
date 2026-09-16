import { NextRequest, NextResponse } from 'next/server';
import { internalError, jsonError, readJsonBody, withApi } from '../../../lib/http';
import { isProduction } from '../../../lib/env';
import { requireAccount, setAccountLocale } from '../../../lib/auth';
import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from '../../../i18n';

/**
 * POST /api/locale { "locale": "en" | "ru" | "es" } — the EXPLICIT language
 * switch, and the ONLY writer of `accounts.locale` (migration 014).
 *
 * It writes two things, and the difference between them is the whole point:
 *
 *   1. the `welcome_locale` cookie — the DEVICE preference, so the choice
 *      survives a sign-out and still applies to a visitor who has no account
 *      (a public page, the sign-in screen);
 *   2. `accounts.locale`, when the request carries a valid session — the
 *      DURABLE preference, so the cabinet opens in the chosen language on a
 *      device that has never seen this cookie. That second write is what fixed
 *      "English everywhere on a device without the cookie".
 *
 * Nothing else may write the column. In particular `?lang=` (src/proxy.ts)
 * writes the cookie and the current render only: a `?lang=` URL is fetched by
 * link unfurlers, chat clients and scanners, so letting it touch the account
 * would let a shared link silently change the language of the user's own
 * account. tests/integration/locale.test.ts pins both halves.
 *
 * Signed-out callers keep working exactly as before — the public pages carry a
 * switcher too, and a visitor without an account has only a device to remember
 * the choice in.
 *
 * A language choice is NOT consent and NOT a security event, so this route
 * writes no consent event and no audit row (src/domain/consent.ts states the
 * same rule from the other side: "a language choice ... is NEVER consent").
 */
async function postRoute(req: NextRequest) {
  try {
    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const raw = body?.['locale'];
    if (!isLocale(raw)) {
      return jsonError(400, 'invalid_locale', 'locale must be one of: en, ru, es');
    }
    const locale: Locale = raw;

    // Best-effort by design: an expired or unknown session must not turn a
    // language switch into an error — the cookie half of the choice is still
    // perfectly valid, and that is what answers this request.
    const auth = await requireAccount(req);
    let accountUpdated = false;
    if (auth) {
      try {
        accountUpdated = await setAccountLocale(auth.accountId, locale);
      } catch {
        // Reported as account:false rather than failing the switch.
        accountUpdated = false;
      }
    }

    const res = NextResponse.json({ ok: true, locale, account: accountUpdated });
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

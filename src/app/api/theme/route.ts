import { NextRequest, NextResponse } from 'next/server';
import { internalError, jsonError, readJsonBody, withApi } from '../../../lib/http';
import { isProduction } from '../../../lib/env';
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, isTheme } from '../../../lib/theme';

/**
 * POST /api/theme { "theme": "soft" | "swiss" | "poster" | null } — enter, move
 * within, or leave design REVIEW MODE.
 *
 * The only writer of the `welcome_theme` cookie, and the deliberate counterpart
 * of POST /api/locale with two differences that are the whole point:
 *
 *   1. there is NO durable half. A language is a statement about the person and
 *      belongs on the account (`accounts.locale`, migration 014); a review theme
 *      is something one person is doing for an hour to judge a card, and it must
 *      not follow them into someone else's session — nor linger on the account of
 *      whoever next signs in on this phone. So: cookie and `?theme=` only, and no
 *      `accounts.theme` column exists.
 *   2. `theme: null` is a VALID request that CLEARS the cookie. "No explicit
 *      theme" is a state the product needs (src/lib/theme.ts): it is the page a
 *      stranger sees, and a reviewer must be able to get back to it without
 *      clearing cookies by hand.
 *
 * A theme choice is not consent and not a security event, so — exactly like the
 * language switch — this route writes no consent event and no audit row, and it
 * does not look up a session: the cookie answers the request on its own.
 */
async function postRoute(req: NextRequest) {
  try {
    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const raw = body?.['theme'];
    // Explicitly present-but-not-a-theme is a client bug and is rejected; absent
    // or `null` means "leave review mode" and is honoured.
    if (raw !== null && raw !== undefined && !isTheme(raw)) {
      return jsonError(400, 'invalid_theme', 'theme must be one of: soft, swiss, poster (or null)');
    }
    const theme = isTheme(raw) ? raw : null;

    const res = NextResponse.json({ ok: true, theme });
    if (theme) {
      res.cookies.set({
        name: THEME_COOKIE,
        value: theme,
        path: '/',
        maxAge: THEME_COOKIE_MAX_AGE,
        sameSite: 'lax',
        secure: isProduction(),
      });
    } else {
      // maxAge 0 is how a cookie is deleted: same name, same path, no value.
      res.cookies.set({
        name: THEME_COOKIE,
        value: '',
        path: '/',
        maxAge: 0,
        sameSite: 'lax',
        secure: isProduction(),
      });
    }
    return res;
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

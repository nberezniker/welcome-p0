import { cookies, headers } from 'next/headers';
import { THEME_COOKIE, resolveRequestTheme, type Theme } from './theme';

/**
 * Request header the proxy sets when `?theme=` is present. It exists for the
 * same reason `x-welcome-locale` does (src/i18n/index.ts): the cookie has to be
 * written on the RESPONSE (it is a preference for the next visit) while the
 * CURRENT render must already use the requested theme — and only the layout can
 * put `data-theme` on `<html>`. Harmless to forge: it selects a stylesheet and
 * never a consent or an authorization decision.
 */
export const THEME_HEADER = 'x-welcome-theme';

/**
 * The review theme for this request, or `null` when none is explicit.
 *
 * Deliberately NOT memoized with React's `cache`, unlike `getLocale()`: the
 * locale is asked for by the layout AND by every page that renders a string,
 * while the theme has exactly one caller (the root layout, which is also the
 * only component allowed to decide `<html data-theme>`). A second caller would
 * be a design mistake, not a reason to cache.
 *
 * Outside a request scope (a component test rendering the layout directly),
 * `cookies()` throws; "no explicit theme" is the honest answer there and is the
 * same state a first-time visitor is in.
 */
export async function getTheme(): Promise<Theme | null> {
  try {
    const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
    return resolveRequestTheme(requestHeaders.get(THEME_HEADER), jar.get(THEME_COOKIE)?.value);
  } catch {
    return null;
  }
}

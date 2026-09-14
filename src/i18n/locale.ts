/**
 * Locale primitives shared by the server, the route handlers and the
 * middleware. Kept dependency-free and free of `next/headers` so the edge
 * middleware can import it without pulling the dictionaries (see
 * src/i18n/README.md).
 */

export type Locale = 'en' | 'ru' | 'es';

export const LOCALES: readonly Locale[] = ['en', 'ru', 'es'] as const;
export const DEFAULT_LOCALE: Locale = 'en';
/** Cookie name for the locale preference. Set by POST /api/locale and by ?lang=. */
export const LOCALE_COOKIE = 'welcome_locale';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
/** Query parameter that overrides (and persists) the locale on public pages. */
export const LOCALE_QUERY_PARAM = 'lang';

/** Validates a raw cookie/header/query value into a known locale. */
export function resolveLocale(value: string | undefined | null): Locale {
  return value === 'ru' || value === 'es' || value === 'en' ? value : DEFAULT_LOCALE;
}

export function isLocale(value: unknown): value is Locale {
  return value === 'ru' || value === 'es' || value === 'en';
}

/**
 * Resolves the locale for one request from the two documented inputs:
 *   1. a VALID `?lang=` query value — an explicit, per-visit choice; the
 *      middleware persists it to the cookie (and the current render already
 *      uses it);
 *   2. otherwise the `welcome_locale` cookie;
 *   3. otherwise English.
 * An invalid `?lang=` (unknown code, different case, extra parameters) is
 * ignored entirely and never overwrites a stored preference.
 */
export function resolveRequestLocale(
  queryLang: string | undefined | null,
  cookieLocale: string | undefined | null,
): { locale: Locale; fromQuery: boolean } {
  if (isLocale(queryLang)) return { locale: queryLang, fromQuery: true };
  return { locale: resolveLocale(cookieLocale), fromQuery: false };
}

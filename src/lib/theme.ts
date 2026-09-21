/**
 * Theme primitives shared by the server, the route handler and the proxy.
 *
 * Dependency-free (no `next/headers`, no node built-ins) for the same reason
 * src/i18n/locale.ts is: the proxy runs on the edge and imports this module, so
 * anything it pulled in would have to be edge-compatible too.
 *
 * WHAT A THEME IS HERE. Not a user preference but a REVIEW MODE: four design
 * directions over ONE markup (src/app/globals.css holds the token sets), used by
 * the owner to judge the card and the event on a real phone. That is why the
 * default is `null` rather than `'soft'`: "no explicit theme" is a real state —
 * the page renders today's look AND no review bar, which is exactly what a
 * stranger opening a shared card must still see.
 *
 * WHY NO `accounts.theme` COLUMN. A language is what a person says about
 * themselves and belongs on the account (migration 014, `accounts.locale`); a
 * review theme is a thing one person is doing for an hour, and it must never
 * follow them into someone else's session on a shared device. A cookie plus
 * `?theme=` is the proportionate carrier, and `?theme=` — like `?lang=` — writes
 * the cookie and the current render ONLY. Nothing here is consent, so no theme
 * write produces a consent event or an audit row.
 */

export type Theme = 'soft' | 'swiss' | 'poster' | 'premium';

/** The four themes, in the order the switcher shows them. */
export const THEMES: readonly Theme[] = ['soft', 'swiss', 'poster', 'premium'] as const;

/**
 * The theme an un-themed page renders as. Not "the theme that is applied" —
 * an un-themed page carries NO `data-theme` at all and gets this look because
 * its token values live on `:root` (see the `soft` block in globals.css). Named
 * here so the switcher, the docs and the tests can say "the default" once.
 */
export const DEFAULT_THEME: Theme = 'soft';

/** Cookie name for the review theme. Set by POST /api/theme and by ?theme=. */
export const THEME_COOKIE = 'welcome_theme';
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
/** Query parameter that enters (and persists) review mode on the public pages. */
export const THEME_QUERY_PARAM = 'theme';

/** Validates a raw cookie/header/query value into a known theme. */
export function isTheme(value: unknown): value is Theme {
  return value === 'soft' || value === 'swiss' || value === 'poster' || value === 'premium';
}

/**
 * The theme of one request, or `null` for "no explicit theme".
 *
 * Two inputs, in this order:
 *   1. a VALID `?theme=` query value — the explicit way INTO review mode, and
 *      the same per-visit override `?lang=` gives the locale (src/proxy.ts);
 *   2. the `welcome_theme` cookie — the choice a reviewer has already made,
 *      which then follows them to every page, including the ones the query
 *      override deliberately does not cover (`/e/<slug>`, the cabinet).
 * An invalid value (`?theme=dark`, `THEME=Swiss`, empty) is IGNORED rather than
 * guessed at: the request stays un-themed and no cookie is written, so a typo in
 * a shared URL cannot silently switch a stranger's page.
 *
 * Pure and dependency-free, so the whole truth table is testable without a
 * request: tests/unit/theme.test.ts.
 */
export function resolveRequestTheme(
  queryTheme: string | undefined | null,
  cookieTheme: string | undefined | null,
): Theme | null {
  if (isTheme(queryTheme)) return queryTheme;
  return isTheme(cookieTheme) ? cookieTheme : null;
}

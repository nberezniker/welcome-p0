import { cookies, headers } from 'next/headers';
import { en, type Dictionary, type DictKey } from './en';
import { ru } from './ru';
import { es } from './es';
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_QUERY_PARAM,
  isLocale,
  resolveLocale,
  resolveRequestLocale,
  type Locale,
} from './locale';

export type { Locale };
export { DEFAULT_LOCALE, LOCALES, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, LOCALE_QUERY_PARAM, isLocale, resolveLocale, resolveRequestLocale };

/**
 * Request header the locale middleware sets when `?lang=` is present. It exists
 * because the cookie has to be written on the RESPONSE (it is a preference for
 * the next visit) while the CURRENT render must already use the requested
 * language — and only the layout can pick `<html lang>`. Harmless to forge: it
 * only selects a dictionary, never a consent or an authorization decision.
 */
export const LOCALE_HEADER = 'x-welcome-locale';

const DICTIONARIES: Record<Locale, Partial<Dictionary>> = { en, ru, es };

export type { Dictionary, DictKey };

/**
 * Returns the dictionary for a locale. For non-English locales the returned
 * object falls back to English for missing keys — see src/i18n/README.md.
 */
export function getDictionary(locale: Locale): Partial<Dictionary> {
  return DICTIONARIES[locale];
}

/** Interpolates {name} placeholders. Unknown variables render as empty string. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = vars[key];
    return v === undefined ? match : String(v);
  });
}

/**
 * Lookup with English fallback: for locales other than 'en' a missing key
 * resolves to the English string so the UI never renders a raw key.
 */
export function t(
  locale: Locale,
  key: DictKey,
  vars?: Record<string, string | number>,
): string {
  const dict = DICTIONARIES[locale];
  const value: string = locale === 'en' ? en[key] : (dict[key] ?? en[key]);
  return interpolate(value, vars);
}

/** Server-side locale resolution for pages/layouts.
 *
 * Resolution order (src/i18n/locale.ts documents the inputs):
 *   1. the header the middleware sets for a valid `?lang=` — already validated,
 *      so the current render matches the query the visitor just asked for;
 *   2. the `welcome_locale` cookie;
 *   3. English.
 * Falls back to the default locale when called outside a request scope
 * (e.g. when component-level tests render a page directly, or a route handler
 * is invoked without a Next request context). */
export async function getLocale(): Promise<Locale> {
  try {
    const [jar, requestHeaders] = await Promise.all([cookies(), headers()]);
    const override = requestHeaders.get(LOCALE_HEADER);
    if (isLocale(override)) return override;
    return resolveLocale(jar.get(LOCALE_COOKIE)?.value);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** Convenience for server components: [locale, bound translator]. */
export async function getT(): Promise<{ locale: Locale; t: (key: DictKey, vars?: Record<string, string | number>) => string }> {
  const locale = await getLocale();
  return { locale, t: (key, vars) => t(locale, key, vars) };
}

/** Current consent policy version recorded with every consent event. */
export const POLICY_VERSION = '2026-09-p0';

import { cookies } from 'next/headers';
import { en, type Dictionary, type DictKey } from './en';
import { ru } from './ru';
import { es } from './es';

export type Locale = 'en' | 'ru' | 'es';

export const LOCALES: readonly Locale[] = ['en', 'ru', 'es'] as const;
export const DEFAULT_LOCALE: Locale = 'en';
/** Cookie name for the locale preference. Set by POST /api/locale. */
export const LOCALE_COOKIE = 'welcome_locale';
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

const DICTIONARIES: Record<Locale, Partial<Dictionary>> = { en, ru, es };

/** Validates a raw cookie/header value into a known locale. */
export function resolveLocale(value: string | undefined | null): Locale {
  return value === 'ru' || value === 'es' || value === 'en' ? value : DEFAULT_LOCALE;
}

export function isLocale(value: unknown): value is Locale {
  return value === 'ru' || value === 'es' || value === 'en';
}

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

/** Server-side locale resolution for pages/layouts: reads the locale cookie. */
export async function getLocale(): Promise<Locale> {
  const jar = await cookies();
  return resolveLocale(jar.get(LOCALE_COOKIE)?.value);
}

/** Convenience for server components: [locale, bound translator]. */
export async function getT(): Promise<{ locale: Locale; t: (key: DictKey, vars?: Record<string, string | number>) => string }> {
  const locale = await getLocale();
  return { locale, t: (key, vars) => t(locale, key, vars) };
}

/** Current consent policy version recorded with every consent event. */
export const POLICY_VERSION = '2026-09-p0';

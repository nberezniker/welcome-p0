import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from './locale';

/**
 * The strings a CLIENT error boundary needs, for three locales.
 *
 * WHY A SECOND COPY OF FOUR STRINGS EXISTS. A client error boundary
 * (src/app/error.tsx, src/app/global-error.tsx) is a `'use client'` module, so
 * it cannot call `getT()` — that reads `next/headers`, which does not exist in
 * the browser. And it has no server parent to pass strings down as props: the
 * only props Next gives an error boundary are `{ error, reset }`. Two ways out,
 * both bad: import `src/i18n/index.ts` (server-only), or import the `en`/`ru`/`es`
 * dictionaries, which would ship ~3,600 lines of copy for the whole app into the
 * browser bundle — precisely what src/i18n/README.md forbids ("Client components
 * receive strings as props from server parents (no dictionary import in client
 * bundles)").
 *
 * So this module is the narrow, honest third option: it mirrors ONLY the keys
 * the crash path renders, in the language of whoever is looking at the crash.
 * The dictionaries remain the source of truth —
 * tests/unit/surface-copy.test.ts compares every string below with the
 * dictionary value for the same key, in all three locales, so the copy cannot
 * drift silently. Edit both together.
 *
 * No imports beyond src/i18n/locale.ts, which is deliberately dependency-free
 * (no `next/headers`, no Node built-ins) so it is safe in a client bundle.
 */

export interface SurfaceCopy {
  /** `errors.500.title` */
  readonly title: string;
  /** `errors.500.text` */
  readonly text: string;
  /** `errors.500.retry` */
  readonly retry: string;
  /** `common.backToHome` */
  readonly home: string;
}

/** Maps each mirrored string to the dictionary key it must equal. */
export const SURFACE_COPY_KEYS = {
  title: 'errors.500.title',
  text: 'errors.500.text',
  retry: 'errors.500.retry',
  home: 'common.backToHome',
} as const satisfies Record<keyof SurfaceCopy, string>;

const COPY: Record<Locale, SurfaceCopy> = {
  en: {
    title: 'Something went wrong on our side',
    text: 'The page could not be shown. Your data is untouched — nothing you saved was lost.',
    retry: 'Try again',
    home: 'Back to home',
  },
  ru: {
    title: 'Что-то пошло не так на нашей стороне',
    text: 'Страницу не удалось показать. С вашими данными ничего не случилось — сохранённое не потеряно.',
    retry: 'Попробовать снова',
    home: 'На главную',
  },
  es: {
    title: 'Algo ha fallado de nuestro lado',
    text: 'No se ha podido mostrar la página. Tus datos están intactos: no se ha perdido nada de lo que guardaste.',
    retry: 'Reintentar',
    home: 'Volver al inicio',
  },
};

export function surfaceCopy(locale: Locale): SurfaceCopy {
  return COPY[locale];
}

/** Reads one cookie from a `document.cookie` string, decoded, or undefined. */
function cookieValue(jar: string, name: string): string | undefined {
  for (const part of jar.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * The locale of the page a crash happened on, resolved in the browser.
 *
 * Order, and its honest limits:
 *   1. the `welcome_locale` cookie — the device preference, and the source the
 *      layout itself used unless a `?lang=` link or the account overrode it.
 *      It is not HttpOnly (it is a display preference, never an authorization
 *      input), so the client can read it;
 *   2. `<html lang>` — set by the root layout from the full server-side
 *      resolution (including `?lang=` and `accounts.locale`), so for a boundary
 *      INSIDE that layout (src/app/error.tsx) this is exactly right;
 *   3. English.
 * `global-error.tsx` is the one case this cannot fully recover: it replaces the
 * document, so `<html lang>` may already be its own, and a visitor who never
 * chose a language but whose ACCOUNT is not English would see the crash copy in
 * English. That is the price of a boundary that has to render its own `<html>`,
 * and English is at least a language the page declares.
 *
 * Called from an effect, never during render: the first render must match the
 * server's, or React reports a hydration mismatch.
 */
export function readClientLocale(): Locale {
  if (typeof document === 'undefined') return DEFAULT_LOCALE;
  const fromCookie = cookieValue(document.cookie, LOCALE_COOKIE);
  if (isLocale(fromCookie)) return fromCookie;
  const fromDocument = document.documentElement.lang;
  return isLocale(fromDocument) ? fromDocument : DEFAULT_LOCALE;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCALE, LOCALES } from '../../src/i18n/locale';
import { SURFACE_COPY_KEYS, readClientLocale, surfaceCopy } from '../../src/i18n/surface-copy';
import { t } from '../../src/i18n';

/**
 * The anti-drift gate for the crash-path copy.
 *
 * src/i18n/surface-copy.ts mirrors four dictionary strings so a CLIENT error
 * boundary (which can neither call `getT()` nor import the dictionaries) has
 * something to render in the reader's language. That mirroring is the only copy
 * duplication in the i18n layer, and it is only acceptable because THIS test
 * fails the moment the two disagree — in any locale, in either direction. The
 * dictionaries stay the source of truth; this file is the seam's inspection
 * hatch.
 */

const FIELDS = Object.keys(SURFACE_COPY_KEYS) as (keyof typeof SURFACE_COPY_KEYS)[];

test('surface copy: every mirrored string equals its dictionary value, in every locale', () => {
  for (const locale of LOCALES) {
    const copy = surfaceCopy(locale);
    for (const field of FIELDS) {
      const key = SURFACE_COPY_KEYS[field];
      assert.equal(
        copy[field],
        t(locale, key),
        `${locale}.${field} drifted from ${key} — change both (src/i18n/${locale}.ts and src/i18n/surface-copy.ts)`,
      );
    }
  }
});

test('surface copy: all three locales are present, non-empty and distinct where they should be', () => {
  assert.deepEqual([...LOCALES], ['en', 'ru', 'es']);
  for (const locale of LOCALES) {
    const copy = surfaceCopy(locale);
    for (const field of FIELDS) {
      assert.ok(copy[field].trim().length > 0, `${locale}.${field} must not be empty`);
    }
  }
  // A stray English string in a translation is the classic silent regression —
  // pin the three that would hurt most (the heading of a crash page).
  assert.notEqual(surfaceCopy('ru').title, surfaceCopy('en').title);
  assert.notEqual(surfaceCopy('es').title, surfaceCopy('en').title);
});

test('surface copy: readClientLocale falls back to English outside a browser', () => {
  // Unit tests have no `document`; this is also the SSR path of the boundaries.
  assert.equal(readClientLocale(), DEFAULT_LOCALE);
});

test('surface copy: readClientLocale prefers the cookie, then <html lang>, then English', () => {
  const g = globalThis as { document?: unknown };
  const saved = g.document;
  const fake = (jar: string, lang: string) => ({ cookie: jar, documentElement: { lang } });
  try {
    // The device preference wins — it is what the layout used.
    g.document = fake('welcome_locale=ru', 'es');
    assert.equal(readClientLocale(), 'ru');
    // No (valid) cookie → the attribute the root layout rendered.
    g.document = fake('other=1', 'es');
    assert.equal(readClientLocale(), 'es');
    // An invalid cookie value is ignored, never guessed at (same rule as
    // src/i18n/locale.ts)…
    g.document = fake('welcome_locale=de', 'ru');
    assert.equal(readClientLocale(), 'ru');
    // …and with nothing usable the default stands.
    g.document = fake('', 'xx');
    assert.equal(readClientLocale(), 'en');
    // Percent-encoded values decode like the ones POST /api/locale writes.
    g.document = fake('welcome_locale=es', 'en');
    assert.equal(readClientLocale(), 'es');
  } finally {
    if (saved === undefined) delete g.document;
    else g.document = saved;
  }
});

test('surface copy: key mapping covers the fields the boundary renders', () => {
  assert.deepEqual(FIELDS.sort(), ['home', 'retry', 'text', 'title']);
  assert.equal(SURFACE_COPY_KEYS.title, 'errors.500.title');
  assert.equal(SURFACE_COPY_KEYS.home, 'common.backToHome');
  // Every mapped key really exists in the dictionaries (a typo here would make
  // the equality test compare against a fallback and look green).
  for (const locale of LOCALES) {
    for (const field of FIELDS) {
      const key = SURFACE_COPY_KEYS[field];
      assert.notEqual(t(locale, key), key, `${key} did not resolve in ${locale}`);
    }
  }
});

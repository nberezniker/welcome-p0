import assert from 'node:assert/strict';
import { test } from 'node:test';
import { en, type Dictionary } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';
import { DEFAULT_LOCALE, LOCALES, getDictionary, isLocale, resolveLocale, t } from '../../src/i18n';

/** Keys deliberately present only in `en` — documented fallbacks (see src/i18n/README.md). */
const ALLOWED_EN_FALLBACK: readonly (keyof Dictionary)[] = [];

function keyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.keys(obj).map((k) => `${prefix}${k}`);
}

test('dictionaries: ru and es cover every en key (or documented fallback)', () => {
  const enKeys = keyPaths(en) as (keyof Dictionary)[];
  const ruDict = ru as Record<string, unknown>;
  const esDict = es as Record<string, unknown>;
  const missingRu = enKeys.filter((k) => !(k in ruDict) && !ALLOWED_EN_FALLBACK.includes(k));
  const missingEs = enKeys.filter((k) => !(k in esDict) && !ALLOWED_EN_FALLBACK.includes(k));
  assert.deepEqual(missingRu, [], `ru is missing keys: ${missingRu.join(', ')}`);
  assert.deepEqual(missingEs, [], `es is missing keys: ${missingEs.join(', ')}`);
});

test('dictionaries: ru and es have no unknown keys', () => {
  const enKeys = new Set(keyPaths(en));
  const unknownRu = Object.keys(ru).filter((k) => !enKeys.has(k));
  const unknownEs = Object.keys(es).filter((k) => !enKeys.has(k));
  assert.deepEqual(unknownRu, [], `ru has unknown keys: ${unknownRu.join(', ')}`);
  assert.deepEqual(unknownEs, [], `es has unknown keys: ${unknownEs.join(', ')}`);
});

test('dictionaries: all values are non-empty strings', () => {
  for (const dict of [en, ru, es] as Record<string, unknown>[]) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${key} must be a string`);
      assert.ok((value as string).length > 0, `${key} must not be empty`);
    }
  }
});

test('dictionaries: placeholder variables match across locales', () => {
  const varRe = /\{(\w+)\}/g;
  const varsOf = (s: string) => new Set([...s.matchAll(varRe)].map((m) => m[1]));
  for (const key of Object.keys(en) as (keyof Dictionary)[]) {
    const expected = varsOf(en[key]);
    for (const dict of [ru, es] as Partial<Dictionary>[]) {
      const value = dict[key];
      if (value !== undefined) {
        assert.deepEqual(
          [...varsOf(value)].sort(),
          [...expected].sort(),
          `${key}: placeholder mismatch`,
        );
      }
    }
  }
});

test('locale resolution: valid values pass, everything else falls back to en', () => {
  assert.equal(resolveLocale('ru'), 'ru');
  assert.equal(resolveLocale('es'), 'es');
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale(undefined), DEFAULT_LOCALE);
  assert.equal(resolveLocale(null), DEFAULT_LOCALE);
  assert.equal(resolveLocale(''), DEFAULT_LOCALE);
  assert.equal(resolveLocale('de'), DEFAULT_LOCALE);
  assert.equal(resolveLocale('RU'), DEFAULT_LOCALE); // case-sensitive: not a valid value
  assert.equal(resolveLocale('en; q=0.9'), DEFAULT_LOCALE);
  assert.equal(isLocale('ru'), true);
  assert.equal(isLocale('xx'), false);
  assert.deepEqual([...LOCALES], ['en', 'ru', 'es']);
});

test('t(): localized lookup, English fallback and interpolation', () => {
  assert.equal(t('en', 'common.save'), 'Save');
  assert.equal(t('ru', 'common.save'), 'Сохранить');
  assert.equal(t('es', 'common.save'), 'Guardar');
  // Interpolation in every locale.
  assert.equal(t('en', 'login.codeSentTo', { email: 'a@b.co' }), 'We sent a 6-digit code to a@b.co.');
  assert.equal(t('ru', 'login.codeSentTo', { email: 'a@b.co' }), 'Мы отправили 6-значный код на a@b.co.');
  // Empty ru/es entry (documented fallback) resolves to English, never a raw key.
  const dict = getDictionary('ru') as Record<string, string | undefined>;
  const saved = dict['common.retry'];
  (ru as Record<string, unknown>)['common.retry'] = undefined;
  try {
    assert.equal(t('ru', 'common.retry'), en['common.retry']);
    assert.doesNotMatch(t('ru', 'common.retry'), /^common\./);
  } finally {
    (ru as Record<string, unknown>)['common.retry'] = saved;
  }
  // Unknown interpolation variables render literally.
  assert.equal(t('en', 'common.save', { x: 1 }), 'Save');
});

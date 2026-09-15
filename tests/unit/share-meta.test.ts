import test from 'node:test';
import assert from 'node:assert/strict';
import type { Metadata } from 'next';
import { canonicalUrl, landingShareMetadata, SITE_NAME } from '../../src/lib/share-meta';
import { LOCALES, t, type Locale } from '../../src/i18n';

/**
 * Landing share metadata (Issue: the marketing page had no og:* / twitter:* tags
 * at all, so pasting the product link produced an empty preview).
 *
 * The assertions are structural on purpose: what must hold is that the
 * advertised URL is the canonical origin, that the locale the page renders in is
 * the locale the unfurl speaks, and that no empty or placeholder text can reach
 * the markup.
 */

const BASE = 'https://welcome.colmogravity.net';

/**
 * Next types `openGraph`/`twitter` as either the input shape or the resolved
 * one, and only the input shape names `type` / `card`. Read through these so the
 * assertions stay on the values the builder actually returned.
 */
interface OgTags {
  title?: string;
  description?: string;
  url?: string;
  siteName?: string;
  type?: string;
}

interface TwitterTags {
  card?: string;
  title?: string;
  description?: string;
}

function og(meta: Metadata): OgTags {
  return (meta.openGraph ?? {}) as OgTags;
}

function twitter(meta: Metadata): TwitterTags {
  return (meta.twitter ?? {}) as TwitterTags;
}

/** The two dictionary keys the landing shares; the same ones the image renders. */
function landingCopy(locale: Locale): { title: string; description: string } {
  return { title: t(locale, 'landing.metaTitle'), description: t(locale, 'landing.metaDescription') };
}

test('landing metadata: advertises the canonical origin, not the deploy host', () => {
  const meta = landingShareMetadata(landingCopy('en'), BASE);
  assert.equal(meta.alternates?.canonical, `${BASE}/`);
  assert.equal(og(meta).url, `${BASE}/`);
  assert.equal(og(meta).type, 'website');
  assert.equal(og(meta).siteName, SITE_NAME);
  assert.equal(twitter(meta).card, 'summary_large_image');
});

test('landing metadata: title and description are the dictionary copy in every locale', () => {
  for (const locale of LOCALES) {
    const copy = landingCopy(locale);
    const meta = landingShareMetadata(copy, BASE);
    assert.deepEqual(meta.title, { absolute: `${copy.title} · ${SITE_NAME}` }, `${locale}: document title`);
    assert.equal(meta.description, copy.description, locale);
    assert.equal(og(meta).title, copy.title, locale);
    assert.equal(og(meta).description, copy.description, locale);
    assert.equal(twitter(meta).title, copy.title, locale);
    assert.equal(twitter(meta).description, copy.description, locale);
    assert.ok(copy.title.trim().length > 0, `${locale}: share title must not be blank`);
    assert.ok(copy.description.trim().length > 0, `${locale}: share description must not be blank`);
  }
  // The three locales are really three different strings, so a missing
  // translation cannot pass by looking like the English fallback.
  const titles = LOCALES.map((locale) => og(landingShareMetadata(landingCopy(locale), BASE)).title);
  assert.equal(new Set(titles).size, LOCALES.length);
});

test('landing metadata: the share copy is free of uninterpolated placeholders', () => {
  for (const locale of LOCALES) {
    const meta = landingShareMetadata(landingCopy(locale), BASE);
    for (const value of [og(meta).title, og(meta).description, twitter(meta).title, twitter(meta).description]) {
      assert.doesNotMatch(String(value), /\{[a-zA-Z0-9_]+\}/, `${locale}: placeholder reached the metadata`);
    }
  }
});

test('landing metadata: blank or placeholder copy throws instead of shipping', () => {
  for (const blank of ['', '   ', '\n\t ']) {
    assert.throws(() => landingShareMetadata({ title: blank, description: 'ok' }, BASE), /title is empty/);
    assert.throws(() => landingShareMetadata({ title: 'ok', description: blank }, BASE), /description is empty/);
  }
  assert.throws(
    () => landingShareMetadata({ title: '{name} — WELCOME', description: 'ok' }, BASE),
    /placeholder/,
  );
});

test('landing metadata: whitespace in the copy is collapsed, never published raw', () => {
  const meta = landingShareMetadata({ title: '  One QR.\n  New acquaintances. ', description: ' ok ' }, BASE);
  assert.deepEqual(meta.title, { absolute: `One QR. New acquaintances. · ${SITE_NAME}` });
  assert.equal(og(meta).description, 'ok');
});

test('canonicalUrl: joins paths onto the configured origin without doubling slashes', () => {
  assert.equal(canonicalUrl(BASE, '/'), `${BASE}/`);
  assert.equal(canonicalUrl(`${BASE}/`, '/'), `${BASE}/`);
  assert.equal(canonicalUrl(`${BASE}///`, '/'), `${BASE}/`);
  assert.equal(canonicalUrl(BASE, '/e/mixer'), `${BASE}/e/mixer`);
  assert.equal(canonicalUrl(BASE, 'e/mixer'), `${BASE}/e/mixer`);
});

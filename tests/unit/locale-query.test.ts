import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_QUERY_PARAM,
  resolveRequestLocale,
} from '../../src/i18n/locale';
import { proxy } from '../../src/proxy';

// ---------------------------------------------------------------------------
// R1 (2026-09-14 usage-matrix): `?lang=` on the public pages.
// The resolver is pure; the locale proxy is the only place that writes the
// cookie, so both are covered here (plus the e2e check on the rendered page).
// ---------------------------------------------------------------------------

test('resolveRequestLocale: a valid ?lang= wins and is reported as query-derived', () => {
  assert.deepEqual(resolveRequestLocale('ru', undefined), { locale: 'ru', fromQuery: true });
  assert.deepEqual(resolveRequestLocale('es', 'en'), { locale: 'es', fromQuery: true });
  assert.deepEqual(resolveRequestLocale('en', 'ru'), { locale: 'en', fromQuery: true });
});

test('resolveRequestLocale: an invalid ?lang= is ignored and never overrides the cookie', () => {
  for (const invalid of ['de', 'RU', 'ru-RU', 'en; q=0.9', '', ' ', 'russian']) {
    assert.deepEqual(
      resolveRequestLocale(invalid, 'ru'),
      { locale: 'ru', fromQuery: false },
      `?lang=${JSON.stringify(invalid)} must not override a stored preference`,
    );
  }
  assert.deepEqual(resolveRequestLocale(undefined, undefined), { locale: DEFAULT_LOCALE, fromQuery: false });
  assert.deepEqual(resolveRequestLocale(null, null), { locale: DEFAULT_LOCALE, fromQuery: false });
  assert.deepEqual(resolveRequestLocale(undefined, 'garbage'), { locale: DEFAULT_LOCALE, fromQuery: false });
});

/** The proxy is invoked exactly as Next's runtime invokes it (Fetch-event style). */
function runProxy(url: string, cookie?: string) {
  const headers: Record<string, string> = { host: 'localhost:3210' };
  if (cookie) headers['cookie'] = cookie;
  const request = new NextRequest(`http://localhost:3210${url}`, { headers });
  return proxy(request);
}

test('proxy: ?lang=ru renders this request in ru and persists the choice in the cookie', () => {
  const res = runProxy('/?lang=ru');
  // 1. persisted for the next visit
  assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`${LOCALE_COOKIE}=ru`));
  assert.match(res.headers.get('set-cookie') ?? '', /Path=\//i);
  // 2. the CURRENT render must already see it: Next forwards the overridden
  //    request headers as x-middleware-request-<name> / x-middleware-override-headers.
  assert.equal(res.headers.get('x-middleware-request-x-welcome-locale'), 'ru');
  assert.match(res.headers.get('x-middleware-request-cookie') ?? '', new RegExp(`${LOCALE_COOKIE}=ru`));
});

test('proxy: an invalid ?lang= is a no-op (no cookie written, nothing forwarded)', () => {
  for (const url of ['/', '/?lang=de', '/?lang=RU', '/?lang=']) {
    const res = runProxy(url, `${LOCALE_COOKIE}=ru`);
    assert.equal(res.headers.get('set-cookie'), null, `${url} must not write a locale cookie`);
    assert.equal(res.headers.get('x-middleware-request-x-welcome-locale'), null);
  }
});

test('proxy: the query parameter overrides an existing cookie for the current render', () => {
  const res = runProxy('/?lang=es', `${LOCALE_COOKIE}=ru`);
  assert.equal(res.headers.get('x-middleware-request-x-welcome-locale'), 'es');
  assert.match(res.headers.get('x-middleware-request-cookie') ?? '', new RegExp(`${LOCALE_COOKIE}=es`));
  assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`${LOCALE_COOKIE}=es`));
});

test('proxy: the override is wired to the query parameter name the links and docs use', () => {
  assert.equal(LOCALE_QUERY_PARAM, 'lang');
});

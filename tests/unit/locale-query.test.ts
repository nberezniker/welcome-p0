import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

// ---------------------------------------------------------------------------
// Migration 014: the DURABLE account preference.
// These pin the ORDER of the four inputs; the I/O half (cookie jar, forwarded
// header, session row) is covered by tests/integration/locale.test.ts and the
// rendered result by tests/e2e/cabinet-locale.spec.ts.
// ---------------------------------------------------------------------------

test('resolveRequestLocale: the account preference outranks the device cookie', () => {
  // The durable preference is what the user chose for their ACCOUNT; the cookie
  // is what one device happens to hold and can be planted by a shared `?lang=`
  // link, so it must never outvote the account.
  assert.deepEqual(resolveRequestLocale(undefined, undefined, 'ru'), { locale: 'ru', fromQuery: false });
  assert.deepEqual(resolveRequestLocale(undefined, undefined, 'es'), { locale: 'es', fromQuery: false });
  assert.deepEqual(resolveRequestLocale(undefined, 'en', 'ru'), { locale: 'ru', fromQuery: false });
  assert.deepEqual(resolveRequestLocale(undefined, 'ru', 'en'), { locale: 'en', fromQuery: false });
  // NULL = "never chose" is not a value: the cookie decides, exactly as before 014.
  assert.deepEqual(resolveRequestLocale(undefined, 'ru', null), { locale: 'ru', fromQuery: false });
  assert.deepEqual(resolveRequestLocale(undefined, undefined, null), { locale: 'en', fromQuery: false });
  // A garbage column cannot widen the union (the DB CHECK is the second guard).
  assert.deepEqual(resolveRequestLocale(undefined, 'ru', 'de'), { locale: 'ru', fromQuery: false });
  assert.deepEqual(resolveRequestLocale(undefined, undefined, 'RU'), { locale: 'en', fromQuery: false });
});

test('resolveRequestLocale: a valid ?lang= wins the render even over the account', () => {
  assert.deepEqual(resolveRequestLocale('en', undefined, 'ru'), { locale: 'en', fromQuery: true });
  assert.deepEqual(resolveRequestLocale('ru', 'en', 'es'), { locale: 'ru', fromQuery: true });
});

test('resolveRequestLocale: the full truth table, so re-ordering the inputs cannot pass unnoticed', () => {
  const cases: {
    label: string;
    query?: string | null;
    cookie?: string | null;
    account?: string | null;
    expect: string;
  }[] = [
    { label: 'signed out, nothing stored', expect: 'en' },
    { label: 'signed out, cookie', cookie: 'ru', expect: 'ru' },
    { label: 'signed out, ?lang=', query: 'es', expect: 'es' },
    { label: 'signed out, invalid ?lang= keeps the cookie', query: 'de', cookie: 'ru', expect: 'ru' },
    { label: 'signed in, never chose, no cookie', account: null, expect: 'en' },
    { label: 'signed in, never chose, cookie (pre-014 behaviour)', account: null, cookie: 'ru', expect: 'ru' },
    { label: 'signed in, account chose, fresh device (THE FIX)', account: 'ru', expect: 'ru' },
    { label: 'signed in, account chose, device cookie disagrees', account: 'ru', cookie: 'en', expect: 'ru' },
    { label: 'signed in, ?lang= wins this render only', query: 'en', account: 'ru', expect: 'en' },
    { label: 'signed in, ?lang= wins over both', query: 'es', cookie: 'en', account: 'ru', expect: 'es' },
  ];
  for (const c of cases) {
    assert.equal(resolveRequestLocale(c.query, c.cookie, c.account).locale, c.expect, c.label);
  }
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

test('proxy: ?lang= is structurally unable to write the account locale', () => {
  // The written half of the asymmetry is asserted in
  // tests/integration/locale.test.ts (a real switch against a real row). This is
  // the structural half: the proxy has no database at all, so no future edit can
  // make a shared `?lang=` link rewrite accounts.locale without first adding an
  // import that fails here.
  const source = readFileSync(path.join(process.cwd(), 'src/proxy.ts'), 'utf8');
  const imports = [...source.matchAll(/^\s*import[^;]*?from\s*'([^']+)'/gm)].map((m) => m[1]!);
  for (const spec of imports) {
    assert.equal(
      /lib\/(db|auth)|i18n\/index/.test(spec),
      false,
      `src/proxy.ts must not import ${spec}: the proxy runs on every public request and owns no account state`,
    );
  }
  assert.equal(/accounts|setAccountLocale|INSERT|UPDATE/.test(source), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { NextRequest } from 'next/server';
import { POST as postLocale } from '../../src/app/api/locale/route';
import { GET as getMe } from '../../src/app/api/me/route';
import { getSessionByToken, setAccountLocale } from '../../src/lib/auth';
import { getSql, closeSql } from '../../src/lib/db';
import { LOCALE_COOKIE } from '../../src/i18n/locale';
import { proxy } from '../../src/proxy';
import { accountIdFromCookie, assertStatus, loginViaOtp, makeRequest, uniqueEmail } from './helpers';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';

/**
 * Migration 014 — the DURABLE locale preference, and the asymmetry around it.
 *
 * The product rule (approved 2026-09-16): the EXPLICIT switcher writes the device
 * cookie AND `accounts.locale`; `?lang=` writes the device cookie and the current
 * render and NEVER the account, because a `?lang=` URL is fetched by link
 * unfurlers, chat clients and scanners, and a shared link must not silently
 * change the language of the user's own account.
 *
 * What is tested here: the two writers against the DATABASE. What each render
 * shows is covered by tests/unit/locale-query.test.ts (the pure order of the four
 * inputs) and tests/e2e/cabinet-locale.spec.ts (a real browser, real cookies).
 */

after(async () => {
  await closeSql();
});

async function signedInCookie(email: string): Promise<string> {
  return loginViaOtp(requestOtp, verifyOtp, email);
}

async function accountLocale(accountId: string): Promise<string | null> {
  const rows = await getSql()<{ locale: string | null }[]>`
    SELECT locale FROM accounts WHERE id = ${accountId} LIMIT 1
  `;
  return rows[0]?.locale ?? null;
}

function setCookieOf(res: Response): string {
  return res.headers.getSetCookie().join('\n');
}

test('locale 014: a SIGNED-IN switch writes the account column and the device cookie', async () => {
  const email = uniqueEmail('locale-in');
  const cookie = await signedInCookie(email);
  const accountId = await accountIdFromCookie(cookie);
  assert.equal(await accountLocale(accountId), null, 'a fresh account has never chosen a language');

  const res = await postLocale(makeRequest('/api/locale', { body: { locale: 'ru' }, cookie }));
  assertStatus(res, 200);
  assert.deepEqual(await res.json(), { ok: true, locale: 'ru', account: true });

  // 1. the DURABLE half — the fix for "English everywhere on a new device"
  assert.equal(await accountLocale(accountId), 'ru');
  // 2. the DEVICE half — unchanged behaviour
  assert.match(setCookieOf(res), new RegExp(`${LOCALE_COOKIE}=ru`));
});

test('locale 014: the stored column is what the resolver reads back for that session', async () => {
  // getLocale() cannot be called outside a request scope (it falls back to the
  // default by design), so the join between the column and the session lookup is
  // asserted here — it is the exact value step 2 of the resolution order consumes.
  const email = uniqueEmail('locale-read');
  const cookie = await signedInCookie(email);
  const token = cookie.split('=')[1]!;

  assert.equal((await getSessionByToken(token))?.locale, null, 'NULL = never chose');

  await postLocale(makeRequest('/api/locale', { body: { locale: 'es' }, cookie }));
  assert.equal((await getSessionByToken(token))?.locale, 'es');
});

test('locale 014: repeating the same language writes nothing (idempotent)', async () => {
  const email = uniqueEmail('locale-repeat');
  const cookie = await signedInCookie(email);
  const accountId = await accountIdFromCookie(cookie);

  const first = await postLocale(makeRequest('/api/locale', { body: { locale: 'es' }, cookie }));
  assert.deepEqual(await first.json(), { ok: true, locale: 'es', account: true });
  // `IS DISTINCT FROM` in setAccountLocale: the second press is a no-op, so the
  // row is not rewritten and the answer says so.
  const second = await postLocale(makeRequest('/api/locale', { body: { locale: 'es' }, cookie }));
  assert.deepEqual(await second.json(), { ok: true, locale: 'es', account: false });
  assert.equal(await accountLocale(accountId), 'es');
  // …while switching to a different language is a real write again.
  const third = await postLocale(makeRequest('/api/locale', { body: { locale: 'en' }, cookie }));
  assert.deepEqual(await third.json(), { ok: true, locale: 'en', account: true });
});

test('locale 014: a SIGNED-OUT switch still works and never touches an account', async () => {
  // The public pages carry a switcher too; a visitor without an account has only
  // a device to remember the choice in.
  const res = await postLocale(makeRequest('/api/locale', { body: { locale: 'ru' } }));
  assertStatus(res, 200);
  assert.deepEqual(await res.json(), { ok: true, locale: 'ru', account: false });
  assert.match(setCookieOf(res), new RegExp(`${LOCALE_COOKIE}=ru`));
});

test('locale 014: an unknown locale is rejected and writes nothing', async () => {
  const email = uniqueEmail('locale-bad');
  const cookie = await signedInCookie(email);
  const accountId = await accountIdFromCookie(cookie);

  for (const body of [{ locale: 'de' }, { locale: 'RU' }, { locale: '' }, {}]) {
    const res = await postLocale(makeRequest('/api/locale', { body, cookie }));
    assertStatus(res, 400);
    assert.equal(setCookieOf(res).includes(LOCALE_COOKIE), false, `${JSON.stringify(body)} must not set a cookie`);
  }
  assert.equal(await accountLocale(accountId), null);
});

test('locale 014: ?lang= writes the device cookie and NEVER the account column', async () => {
  const email = uniqueEmail('locale-query');
  const cookie = await signedInCookie(email);
  const accountId = await accountIdFromCookie(cookie);
  await postLocale(makeRequest('/api/locale', { body: { locale: 'ru' }, cookie }));
  assert.equal(await accountLocale(accountId), 'ru');

  // A signed-in user follows a shared link that carries a language.
  const request = new NextRequest('http://localhost:3000/?lang=en', {
    headers: { host: 'localhost:3000', cookie },
  });
  const res = proxy(request);
  assert.match(setCookieOf(res), new RegExp(`${LOCALE_COOKIE}=en`), 'the device preference does follow the link');
  assert.equal(res.headers.get('x-middleware-request-x-welcome-locale'), 'en', 'this render follows the link');

  // …and the ACCOUNT does not: their own cabinet stays in the language they chose.
  assert.equal(await accountLocale(accountId), 'ru', '?lang= must never rewrite accounts.locale');

  // Nor can it, indirectly: the locale route is the only writer, and it is the
  // one that requires the explicit POST. (The structural half of this claim —
  // the proxy has no database import at all — is in the unit suite.)
});

test('locale 014: setAccountLocale validates nothing itself but reports a real write', async () => {
  // The route validates; this function is the single storage primitive. It has to
  // answer honestly, because the API response carries its answer to the client.
  const email = uniqueEmail('locale-primitive');
  const cookie = await signedInCookie(email);
  const accountId = await accountIdFromCookie(cookie);

  assert.equal(await setAccountLocale(accountId, 'ru'), true);
  assert.equal(await setAccountLocale(accountId, 'ru'), false);
  assert.equal(await setAccountLocale(accountId, 'en'), true);
  // An account id that does not exist changes no row and says so.
  assert.equal(await setAccountLocale('00000000-0000-0000-0000-000000000000', 'ru'), false);
});

test('locale 014: the DB admits only the closed registry, with NULL meaning "never chose"', async () => {
  const sql = getSql();
  const email = uniqueEmail('locale-check');
  const cookie = await signedInCookie(email);
  const accountId = await accountIdFromCookie(cookie);

  const cols = await sql<{ is_nullable: string; column_default: string | null }[]>`
    SELECT is_nullable, column_default FROM information_schema.columns
    WHERE table_name = 'accounts' AND column_name = 'locale'
  `;
  assert.equal(cols.length, 1, 'accounts.locale must exist (migration 014)');
  assert.equal(cols[0]?.is_nullable, 'YES', 'NULL is the "never chose" state, so the column stays nullable');
  assert.equal(cols[0]?.column_default, null, 'no default: a default would invent a choice nobody made');

  for (const bad of ['de', 'RU', 'ru-RU', '', 'english']) {
    await assert.rejects(
      sql`UPDATE accounts SET locale = ${bad} WHERE id = ${accountId}`,
      (err: { code?: string }) => err.code === '23514',
      `accounts_locale_check must reject ${JSON.stringify(bad)}`,
    );
  }
  for (const good of ['en', 'ru', 'es']) {
    await sql`UPDATE accounts SET locale = ${good} WHERE id = ${accountId}`;
    assert.equal(await accountLocale(accountId), good);
  }
  // The column is a preference, not a consent: nothing about it is a consent event.
  const consentRows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM consent_events WHERE account_id = ${accountId}
  `;
  assert.equal(consentRows[0]?.count, 0, 'a language choice is never recorded as consent');
});

test('locale 014: the switcher does not break an unrelated authenticated route', async () => {
  // Set through the route, then read by ANOTHER authenticated handler — proves the
  // extra column in the session join did not disturb the existing routes.
  const email = uniqueEmail('locale-untouched');
  const cookie = await signedInCookie(email);
  await postLocale(makeRequest('/api/locale', { body: { locale: 'ru' }, cookie }));
  const res = await getMe(makeRequest('/api/me', { cookie }));
  assertStatus(res, 200);
  assert.equal((await res.json() as { ok?: boolean }).ok, true);
});

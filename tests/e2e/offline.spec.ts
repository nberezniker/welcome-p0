import { test, expect, type Page } from '@playwright/test';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';

/**
 * AC-47 — no network on a device that is already showing the app.
 *
 * The criterion ("нет сети на незагруженном телефоне → не обещать offline web;
 * видимое состояние") is about honesty in both directions, so both are asserted
 * in a REAL browser with the context taken offline (`context.setOffline(true)` —
 * the state a phone in a lift is in):
 *
 *   1. an action taken on a page the user already has open FAILS VISIBLY and in
 *      the reader's own language: the join button reports a network error, the
 *      page it sits on stays rendered (no blank screen), and nothing reports
 *      success;
 *   2. a cold navigation with no network is NOT papered over — the app installs
 *      no service worker and declares no web-app manifest, so it never promised
 *      an offline experience, and the browser's own network error is the honest
 *      outcome.
 *
 * The recovery step in (1) matters as much as the failure: the same click, with
 * the network back, reaches the server and joins — that is what makes the
 * assertions above about the OFFLINE state rather than about a broken page.
 *
 * Both strings come from the dictionaries instead of being typed into this file:
 * a translation edit that left the error untranslated would otherwise turn this
 * gate green while the reader still saw English.
 */

/** Client JS is live once the layout's HydrationMarker has run. */
async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

async function loginViaOtp(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await waitHydrated(page);
  await page.getByTestId('login-email').fill(email);
  const requested = page.waitForResponse(
    (r) => r.url().includes('/api/auth/otp/request') && r.request().method() === 'POST',
  );
  await page.getByTestId('login-request').click();
  const body = (await (await requested).json()) as { devCode?: string };
  if (!body.devCode) throw new Error('devCode missing from the OTP request response');
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL(/\/(me|onboarding)$/, { timeout: 30_000 });
}

/**
 * One account that owns a card and an event and is NOT a member of that event,
 * so `/e/<slug>` offers the join button a real user would press.
 *
 * The event is created through the organizer API with the browser's own session
 * cookie (page.request shares the context's cookies): this spec is about offline
 * behaviour, not about the create-event form, which smoke.spec.ts already drives
 * through the UI. Each test seeds its own slug and account because the e2e
 * database persists across tests in a run.
 */
async function seedOwner(page: Page, opts: { email: string; name: string; slug: string }): Promise<string> {
  await loginViaOtp(page, opts.email);

  await page.goto('/me/profile');
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill(opts.name);
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  await page.goto('/me');
  await waitHydrated(page);
  const publicUrl = (await page.getByTestId('public-url').textContent())?.trim() ?? '';
  expect(publicUrl).toContain('/p/');

  const created = await page.request.post('/api/organizer/events', {
    data: { name: `Offline ${opts.slug}`, slug: opts.slug, mode: 'offline', access_mode: 'public', timezone: 'UTC' },
  });
  const createdBody = await created.text();
  expect(created.status(), createdBody).toBe(201);

  return new URL(publicUrl).pathname;
}

/**
 * The language this account reads the app in, set through the real switcher on
 * `/me` (POST /api/locale → the device cookie AND accounts.locale). The switcher
 * is used rather than `?lang=`: the query override is deliberately scoped to the
 * four public entry points in src/proxy.ts and does not cover the event page,
 * while the account preference follows the user everywhere — which is the state
 * a real reader is in.
 */
async function switchToRussian(page: Page): Promise<void> {
  await page.goto('/me');
  await waitHydrated(page);
  const posted = page.waitForResponse((r) => r.url().includes('/api/locale') && r.request().method() === 'POST');
  await page.getByTestId('locale-switcher').getByRole('button', { name: /: RU$/ }).click();
  expect((await posted).status()).toBe(200);
  await waitHydrated(page);
}

test("AC-47: losing the network on an open page fails visibly, in the reader's language, and never silently", async ({ page, context }) => {
  const SLUG = 'e2e-offline-mixer-a';
  const cardPath = await seedOwner(page, { email: 'offline-owner-a@example.org', name: 'Offline Owner A', slug: SLUG });
  await switchToRussian(page);

  const opened = await page.goto(`/e/${SLUG}`);
  expect(opened?.status()).toBe(200);
  await waitHydrated(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

  const join = page.getByTestId('join-button');
  await expect(join).toBeVisible();
  const joinLabel = ru['event.joinCta'] ?? en['event.joinCta'];
  await expect(join).toHaveText(joinLabel);

  // The phone goes into the lift. The page stays open — exactly the state the
  // criterion describes.
  await context.setOffline(true);
  await join.click();

  // 1. A visible, localized failure: the dictionary's own network-error string,
  //    announced as an alert rather than hinted at in passing.
  // Scoped to the paragraph: Next renders its own `[role="alert"]` route
  // announcer (#__next-route-announcer__), which is a different element and
  // would otherwise make this selector ambiguous.
  const failure = page.locator('p[role="alert"]');
  await expect(failure).toBeVisible({ timeout: 15_000 });
  await expect(failure).toHaveText(ru['common.errorNetwork'] ?? en['common.errorNetwork']);

  // 2. No silent success: the join did not happen, so nothing may claim it did,
  //    and the control returns to its resting state (not stuck on "Joining…").
  await expect(page.getByTestId('join-success')).toHaveCount(0);
  await expect(page.getByTestId('member-panel')).toHaveCount(0);
  await expect(join).toBeEnabled();
  await expect(join).toHaveText(joinLabel);

  // 3. No blank screen: the page the reader was on is still complete, article and
  //    affordances included.
  await expect(page.locator('h1')).toHaveText(`Offline ${SLUG}`);
  await expect(page.getByTestId('event-share')).toBeVisible();
  await expect(page.getByTestId('join-area')).toBeVisible();
  expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(0);

  // 4. The failure was the NETWORK, not the page: with the network back the same
  //    click is accepted, and the member panel only renders for a viewer the
  //    server considers an active member (the page reloads after a join).
  await context.setOffline(false);
  await join.click();
  await expect(page.getByTestId('member-panel')).toBeVisible({ timeout: 30_000 });
  expect(cardPath).toContain('/p/');
});

test('AC-47: a cold navigation with no network is not papered over — nothing offline was ever promised', async ({ page, context }) => {
  const SLUG = 'e2e-offline-mixer-b';
  const cardPath = await seedOwner(page, { email: 'offline-owner-b@example.org', name: 'Offline Owner B', slug: SLUG });

  // Warm both pages online first: the card and the event page are the two pages a
  // user is most likely to have open.
  for (const path of [`/e/${SLUG}`, cardPath]) {
    const res = await page.goto(path);
    expect(res?.status(), `GET ${path}`).toBe(200);
  }

  // The promise that is NOT made: no service worker is installed, and no web-app
  // manifest declares an installable/offline experience. An app that intends to
  // survive a cold offline load has to install one of the two; this one has
  // neither, which is why the cold case below is allowed to fail at the network
  // layer instead of being faked with a stale shell.
  const workers = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
  expect(workers, 'no service worker may be installed').toBe(0);
  expect(await page.locator('link[rel="manifest"]').count(), 'no manifest may promise an offline app').toBe(0);

  await context.setOffline(true);

  // Cold navigation: the app cannot load, and it does not pretend it did — the
  // browser reports the network failure rather than leaving a blank screen with
  // no explanation.
  const failed = await page.goto(`/e/${SLUG}`).catch((err: Error) => err);
  expect(failed, 'an offline cold load must fail at the network layer').toBeInstanceOf(Error);
  expect(String((failed as Error).message ?? failed)).toContain('ERR_INTERNET_DISCONNECTED');

  // The card behaves identically — the two pages are treated the same way.
  const cardFailed = await page.goto(cardPath).catch((err: Error) => err);
  expect(cardFailed).toBeInstanceOf(Error);

  // Nothing was cached behind our back either: the same navigation succeeds as
  // soon as the network is back, showing the real page rather than a stale copy
  // that would have made the failure above invisible.
  await context.setOffline(false);
  const back = await page.goto(cardPath);
  expect(back?.status()).toBe(200);
  await waitHydrated(page);
  await expect(page.getByTestId('pubcard-name')).toHaveText('Offline Owner B');
});

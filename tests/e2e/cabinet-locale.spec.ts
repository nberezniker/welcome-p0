import { test, expect, type Page } from '@playwright/test';

/**
 * The DURABLE language preference (migration 014), end to end.
 *
 * The complaint this closes: "the cabinet's translations work when
 * `welcome_locale=ru` is present" — i.e. only on the device that happens to hold
 * the cookie. A signed-in user who picks Russian on their laptop met an English
 * cabinet on their phone.
 *
 * The rule exercised here, in a REAL browser with REAL cookies:
 *
 *   - the explicit switcher writes the device cookie AND `accounts.locale`, so
 *     clearing the cookie — and arriving from a SECOND, cookie-less browser
 *     context — must not change the cabinet's language;
 *   - `?lang=` (the public entry points) writes the device cookie and the current
 *     render and never the account, so following a shared `/?lang=en` link must
 *     not silently re-language the user's own cabinet.
 *
 * Each test owns its account, because the e2e database persists across runs and
 * `accounts.locale` outlives a browser context by design. What is asserted at the
 * DB level is in tests/integration/locale.test.ts; the order of the four inputs is
 * in tests/unit/locale-query.test.ts.
 */

const EMAIL_ACCOUNT = 'cabinet-locale-account@example.org';
const EMAIL_QUERY = 'cabinet-locale-query@example.org';
const EMAIL_INVALID = 'cabinet-locale-invalid@example.org';

async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

async function loginViaOtp(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await waitHydrated(page);
  await page.getByTestId('login-email').fill(email);
  const responsePromise = page.waitForResponse(
    (r) => r.url().includes('/api/auth/otp/request') && r.request().method() === 'POST',
  );
  await page.getByTestId('login-request').click();
  const body = (await (await responsePromise).json()) as { devCode?: string };
  if (!body.devCode) throw new Error('devCode missing from OTP request response');
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL(/\/(me|onboarding)$/, { timeout: 30_000 });
}

async function createProfile(page: Page, displayName: string): Promise<void> {
  await page.goto('/me/profile');
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill(displayName);
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();
}

/** `<html lang>` is the one place the resolved locale is stated for the whole document. */
async function expectLang(page: Page, lang: string) {
  await expect(page.locator('html')).toHaveAttribute('lang', lang);
}

/**
 * The explicit switch: presses the control and returns the API status.
 *
 * The response BODY is deliberately not read here — the switcher reloads the page
 * on success, and Playwright cannot fetch a body for a response the page has
 * navigated away from. What the body said about the account write is asserted in
 * tests/integration/locale.test.ts; what is asserted HERE is the part only a
 * browser can show: the language actually rendered afterwards.
 */
async function switchTo(page: Page, code: 'EN' | 'RU' | 'ES'): Promise<number> {
  const posted = page.waitForResponse(
    (r) => r.url().includes('/api/locale') && r.request().method() === 'POST',
  );
  await page.getByTestId('locale-switcher').getByRole('button', { name: new RegExp(`: ${code}$`) }).click();
  const status = (await posted).status();
  await waitHydrated(page);
  return status;
}

test('cabinet locale: a SECOND cookie-less device follows the account, not the cookie', async ({ page, context, browser }) => {
  await loginViaOtp(page, EMAIL_ACCOUNT);
  await createProfile(page, 'Locale Owner');

  // Before any explicit choice an account has no language: English, as always.
  // globalSetup rebuilds the schema for every run and this email is used by no
  // other spec, so there is no earlier choice to inherit.
  await page.goto('/me/privacy');
  await expectLang(page, 'en');

  // THE explicit switch — the only writer of accounts.locale.
  expect(await switchTo(page, 'RU')).toBe(200);
  await page.goto('/me/privacy');
  await expectLang(page, 'ru');

  // 1. The cookie is not what keeps it: drop it and reload on the SAME device.
  const cookies = await context.cookies();
  expect(cookies.some((c) => c.name === 'welcome_locale' && c.value === 'ru')).toBe(true);
  await context.clearCookies({ name: 'welcome_locale' });
  await page.goto('/me/privacy');
  await expectLang(page, 'ru');
  await expect(page.getByRole('heading', { name: 'Приватность' })).toBeVisible();

  // 2. The reported defect itself: a device that has never seen the cookie. A
  //    second context carries only the session — no locale cookie at all.
  const state = await context.storageState();
  const sessionOnly = {
    cookies: state.cookies.filter((c) => c.name === 'welcome_session'),
    origins: [],
  };
  const otherDevice = await browser.newContext({ storageState: sessionOnly });
  try {
    const otherPage = await otherDevice.newPage();
    await otherPage.goto('/me/privacy');
    await expectLang(otherPage, 'ru');
    await expect(otherPage.getByRole('heading', { name: 'Приватность' })).toBeVisible();
  } finally {
    await otherDevice.close();
  }
});

test('cabinet locale: a shared ?lang= link changes the device and the page, never the cabinet', async ({ page, context }) => {
  await loginViaOtp(page, EMAIL_QUERY);
  await createProfile(page, 'Locale Query Owner');

  await page.goto('/me');
  expect(await switchTo(page, 'RU')).toBe(200);
  await page.goto('/me');
  await expectLang(page, 'ru');

  // A link unfurler, a chat client or a scanner fetches /?lang=en. The visitor is
  // signed in here, so this is exactly the case the rule exists for.
  const landing = await page.goto('/?lang=en');
  expect(landing?.status()).toBe(200);
  await expectLang(page, 'en'); // this render follows the link

  // The device remembers the link's language…
  const cookies = await context.cookies();
  expect(cookies.some((c) => c.name === 'welcome_locale' && c.value === 'en')).toBe(true);

  // …but the user's own cabinet is still in the language they chose: a query
  // parameter may never rewrite accounts.locale.
  await page.goto('/me/privacy');
  await expectLang(page, 'ru');
  await expect(page.getByRole('heading', { name: 'Приватность' })).toBeVisible();

  // And every later visit agrees, cookie or no cookie.
  await context.clearCookies({ name: 'welcome_locale' });
  await page.goto('/me');
  await expectLang(page, 'ru');
});

test('cabinet locale: an invalid ?lang= never moves anything for a signed-in user', async ({ page }) => {
  await loginViaOtp(page, EMAIL_INVALID);
  await createProfile(page, 'Locale Invalid Owner');

  await page.goto('/me');
  expect(await switchTo(page, 'ES')).toBe(200);

  await page.goto('/?lang=de');
  await expectLang(page, 'es'); // ignored: neither the render nor the account moves
  await page.goto('/me/privacy');
  await expectLang(page, 'es');
});

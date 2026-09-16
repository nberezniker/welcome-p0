import { test, expect, type Page } from '@playwright/test';

/**
 * /me/privacy — the regression that the unit and integration suites could not
 * catch.
 *
 * DEFECT (2026-09-16): GET /me/privacy answered 500 for every signed-in user.
 * The page is a server component and imported `CONSENT_PURPOSES_UI` from
 * `./privacy-panel`, which is a `'use client'` module. Next replaces every export
 * of a client module with a client REFERENCE in the server graph, so the page
 * held a proxy object and
 *
 *   TypeError: {imported module ./src/app/me/privacy/privacy-panel.tsx}
 *              .CONSENT_PURPOSES_UI.map is not a function
 *
 * was thrown while rendering. Nothing statically visible was wrong: `pnpm
 * typecheck` and `pnpm lint` were green, the unit suite was green, and so was the
 * whole integration suite — a client boundary only exists once Next compiles the
 * real graph FOR A REQUEST, and the integration renderer calls the page function
 * directly. The e2e global-setup warmup did request /me/privacy, but signed out,
 * so it saw a redirect to /login (status < 500) and never reached the render.
 *
 * This spec therefore does the one thing that would have caught it: it signs in,
 * loads the page and asserts a 200 plus the six consent rows. It fails on the
 * pre-fix tree with the 500 and passes after the fix.
 */

const EMAIL = 'privacy-consents@example.org';

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

/** The authenticated shell requires a profile (/me bounces without one). */
async function createProfile(page: Page, displayName: string): Promise<void> {
  await page.goto('/me/profile');
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill(displayName);
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();
}

test('privacy: the consents page renders for a signed-in user (regression: client-boundary 500)', async ({ page }) => {
  await loginViaOtp(page, EMAIL);
  await createProfile(page, 'Privacy Owner');

  // The status is asserted explicitly: the defect was a 500, not a blank section.
  const response = await page.goto('/me/privacy');
  expect(response?.status(), 'GET /me/privacy must not fail to render').toBe(200);
  await waitHydrated(page);

  // All six toggleable purposes render, with a label, a description and a state.
  const purposes = [
    'public_card',
    'event_directory',
    'introduction_fields',
    'service_channel',
    'organizer_marketing',
    'product_marketing',
  ];
  for (const purpose of purposes) {
    const row = page.getByTestId(`consent-${purpose}`);
    await expect(row, `the ${purpose} consent row must render`).toBeVisible();
    await expect(page.getByTestId(`consent-state-${purpose}`)).toBeVisible();
    await expect(page.getByTestId(`consent-toggle-${purpose}`)).toBeVisible();
    // A typo'd dictionary key would surface as the raw key here.
    await expect(row).not.toContainText('privacy.purpose.');
  }

  // The rest of the page is there too, so the 500 did not merely move.
  await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible();
  await expect(page.getByTestId('export-button')).toBeVisible();
  await expect(page.getByTestId('delete-account-open')).toBeVisible();

  // The page is interactive (the client half of the boundary still works): a
  // consent toggle round-trips to the API and re-renders from state.
  const toggle = page.getByTestId('consent-toggle-organizer_marketing');
  const before = await page.getByTestId('consent-state-organizer_marketing').textContent();
  const write = page.waitForResponse(
    (r) => r.url().includes('/api/consents') && r.request().method() === 'POST',
  );
  await toggle.click();
  expect((await write).status()).toBe(200);
  await expect(page.getByTestId('consent-state-organizer_marketing')).not.toHaveText(before ?? '');
});

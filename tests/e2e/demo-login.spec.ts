import { test, expect, type Page } from '@playwright/test';

/**
 * Demo login (ADR 0009 sibling path: AUTH_EXPOSE_DEMO_OTP).
 *
 * Two cases, deliberately proven in two different ways:
 *   - ENABLED — the REAL flag is on in the running server (playwright.config.ts
 *     webServer.env) and the discovery endpoint is hit for real: the link must
 *     appear and drive a real OTP request for the seeded demo address.
 *   - DISABLED — the discovery endpoint is mocked to answer "off" while the
 *     server flag is still on. The link must NOT appear, which proves the UI is
 *     driven by the endpoint's per-request answer rather than anything baked
 *     into the build.
 */

const DEMO_EMAIL = 'demo1@welcome.test';

/** Client JS is live once the layout's HydrationMarker has run. */
async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

test('demo login enabled: the link appears and prefills the seeded demo account', async ({ page }) => {
  await page.goto('/login');
  await waitHydrated(page);

  const link = page.getByTestId('demo-login-link');
  await expect(link).toBeVisible({ timeout: 15_000 });

  const otpResponse = page.waitForResponse(
    (r) => r.url().includes('/api/auth/otp/request') && r.request().method() === 'POST',
  );
  await link.click();

  const response = await otpResponse;
  expect(response.status()).toBe(200);
  // The click must request a code for the demo address, not for an empty form.
  expect((response.request().postDataJSON() as { email: string }).email).toBe(DEMO_EMAIL);

  // The ordinary code step takes over, addressed to the demo account.
  await expect(page.getByTestId('login-code')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(DEMO_EMAIL)).toBeVisible();
  // AUTH_DEV_EXPOSE_OTP=true on the e2e server, so the code is on screen and
  // the demo flow is completable without an email provider.
  await expect(page.getByTestId('dev-hint')).toBeVisible();
});

test('demo login disabled: no demo affordance is rendered', async ({ page }) => {
  // Mock the discovery endpoint to "off" while the server flag stays ON.
  await page.route('**/api/auth/demo-login-info', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify({ demoLoginEnabled: false, demoEmail: null }),
    });
  });

  const infoResponse = page.waitForResponse((r) => r.url().includes('/api/auth/demo-login-info'));
  await page.goto('/login');
  await waitHydrated(page);
  await infoResponse;

  // The ordinary email form is intact...
  await expect(page.getByTestId('login-request')).toBeVisible();
  await expect(page.getByTestId('login-email')).toBeVisible();
  // ...and the demo entry point is absent.
  await expect(page.getByTestId('demo-login-link')).toHaveCount(0);
});

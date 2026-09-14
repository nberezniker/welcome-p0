import { test, expect, type Page } from '@playwright/test';

/**
 * Active devices on /me/security: a second real session must show up in the
 * list, and revoking it must actually kill that session (proven by the other
 * browser context being bounced to /login), not just remove a row from the DOM.
 */

const ACCOUNT_EMAIL = 'sessions-e2e@example.org';

/** Client JS is live once the layout's HydrationMarker has run. */
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
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { ok: boolean; devCode?: string };
  if (!body.devCode) throw new Error('devCode missing from the OTP request response');
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL(/\/(me|onboarding)$/, { timeout: 30_000 });
}

test('sessions: the device list shows both sessions and revoking one ends it', async ({ page, browser }) => {
  await loginViaOtp(page, ACCOUNT_EMAIL);

  // A genuinely separate session: its own cookie jar, its own session row.
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await loginViaOtp(otherPage, ACCOUNT_EMAIL);

  await page.goto('/me/security');
  await waitHydrated(page);

  const panel = page.getByTestId('sessions-panel');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  // Exactly one of the two sessions is marked as this device.
  await expect(page.getByTestId('session-current')).toHaveCount(1);

  const rows = panel.locator('li[data-testid^="session-"]');
  await expect(rows).toHaveCount(2);

  // Only the OTHER session offers a per-row sign-out: the device you are holding
  // is covered by "sign out everywhere" instead.
  const revokeButtons = panel.locator('[data-testid^="session-revoke-"]');
  await expect(revokeButtons).toHaveCount(1);
  await expect(page.getByTestId('sessions-revoke-all')).toBeVisible();

  // Revoke the OTHER session (the one this page is not using).
  await revokeButtons.first().click();
  await expect(page.getByTestId('session-revoke-confirm')).toBeVisible();
  const revokeResponse = page.waitForResponse(
    (r) => /\/api\/me\/sessions\/[0-9a-f-]+$/.test(r.url()) && r.request().method() === 'DELETE',
  );
  await page.getByTestId('session-revoke-confirm').click();
  const response = await revokeResponse;
  expect(response.status()).toBe(200);
  expect((await response.json()) as { current_revoked: boolean }).toMatchObject({ current_revoked: false });

  // The row is gone from the refreshed list…
  await expect(rows).toHaveCount(1);
  await expect(revokeButtons).toHaveCount(0);
  // …and the other browser really is signed out.
  await otherPage.goto('/me/security');
  await expect(otherPage).toHaveURL(/\/login/, { timeout: 15_000 });

  await otherContext.close();
});

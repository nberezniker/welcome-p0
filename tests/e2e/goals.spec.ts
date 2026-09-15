import { test, expect, type Page } from '@playwright/test';

/**
 * Goal picker e2e (matching v4 §B2): pick up to three private goals, see the
 * priority order, get stopped at the limit — and check that a goal never
 * reaches the public card.
 */

const EMAIL = 'goals@example.org';

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

test('goals: pick up to three in priority order, saved and restored, never on the card', async ({ page }) => {
  await loginViaOtp(page, EMAIL);
  await page.goto('/me/profile');
  await expect(page.getByTestId('pf-name')).toBeVisible();
  await page.getByTestId('pf-name').fill('Goals Owner');
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  const picker = page.getByTestId('pf-goals');
  await expect(picker).toBeVisible();

  // Three picks, in this order: the chips carry their rank.
  await page.getByTestId('goal-fundraise').click();
  await page.getByTestId('goal-hire').click();
  await page.getByTestId('goal-find-mentor').click();
  await expect(page.getByTestId('goal-fundraise')).toHaveText('1. Fundraise');
  await expect(page.getByTestId('goal-hire')).toHaveText('2. Hire');
  await expect(page.getByTestId('goal-find-mentor')).toHaveText('3. Find a mentor');
  await expect(page.getByTestId('pf-goals-counter')).toHaveText('3 of 3');

  // A fourth pick is refused in the UI, before any request.
  await page.getByTestId('goal-invest').click();
  await expect(page.getByTestId('pf-goals-limit')).toBeVisible();
  await expect(page.getByTestId('goal-invest')).toHaveText('Invest');

  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  // Server round-trip: the order survives a reload.
  await page.reload();
  await waitHydrated(page);
  await expect(page.getByTestId('goal-fundraise')).toHaveText('1. Fundraise');
  await expect(page.getByTestId('goal-find-mentor')).toHaveText('3. Find a mentor');

  // Private by construction: the public card shows none of it.
  await page.goto('/me');
  const publicUrl = await page.getByTestId('public-url').textContent();
  await page.goto(publicUrl!);
  await waitHydrated(page);
  const card = await page.content();
  expect(card).not.toContain('Fundraise');
  expect(card).not.toContain('Find a mentor');
  expect(card).not.toContain('goals-picker');
});

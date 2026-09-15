import { test, expect, type Page } from '@playwright/test';

/**
 * /me/connections e2e (interop §A4): reached from the profile nav, it states the
 * per-instance status of every provider, the reason when it is unavailable, and
 * expands into the setup steps.
 */

const EMAIL = 'connections@example.org';

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

test('connections: reachable from the profile nav, statuses and reasons render, setup expands', async ({ page }) => {
  await loginViaOtp(page, EMAIL);

  // Reached from the nav of the authenticated shell, not by typing a URL.
  const nav = page.getByTestId('me-nav');
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: 'Connections' }).click();
  await page.waitForURL('**/me/connections');
  await expect(page.getByTestId('connections-title')).toHaveText('Connections');

  // Every provider in the registry has a card with a human status.
  await expect(page.locator('li[data-status]')).toHaveCount(15);
  await expect(page.getByTestId('provider-vcard')).toHaveAttribute('data-status', 'live');
  await expect(page.getByTestId('provider-status-vcard')).toHaveText('Available');
  await expect(page.getByTestId('provider-ics')).toHaveAttribute('data-status', 'planned');
  await expect(page.getByTestId('provider-status-ics')).toHaveText('Coming soon');
  await expect(page.getByTestId('provider-linkedin')).toHaveAttribute('data-status', 'disabled');

  // Honest states: an unconfigured channel names the variable it needs.
  await expect(page.getByTestId('provider-telegram')).toHaveAttribute('data-status', 'disabled');
  await expect(page.getByTestId('provider-status-telegram')).toHaveText('Unavailable');
  await expect(page.getByTestId('provider-reason-telegram')).toContainText('TELEGRAM_BOT_TOKEN');

  // "How to connect" is a real disclosure: collapsed, then expanded with steps.
  const setup = page.getByTestId('provider-setup-telegram');
  expect(await setup.getAttribute('open')).toBeNull();
  await setup.locator('summary').click();
  await expect(setup).toHaveAttribute('open', '');
  await expect(setup).toContainText('@BotFather');
  await expect(page.getByTestId('provider-env-telegram')).toContainText('TELEGRAM_BOT_TOKEN');

  // The honesty block is on the same page.
  await expect(page.getByTestId('connections-privacy')).toContainText('We never scrape LinkedIn');

  // Only variable NAMES can ever reach the browser.
  expect(await page.content()).toContain('RESEND_API_KEY');
});

test('connections: signed-out visitors are sent to the sign-in page', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/me/connections');
  await page.waitForURL('**/login**');
  expect(page.url()).toContain('/login');
  await expect(page.getByTestId('connections-title')).toHaveCount(0);
  await context.close();
});

import { test, expect, type Page } from '@playwright/test';

/**
 * /me/connections e2e (interop §A4): reached from the profile nav, it states the
 * per-instance status of every provider, the reason when it is unavailable, and
 * expands into the setup steps.
 */

const EMAIL = 'connections@example.org';
/** Its own account so the Google assertions do not depend on the other test's state. */
const GOOGLE_EMAIL = 'connections-google@example.org';

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

/** Creates the profile the authenticated shell requires (/me bounces without one). */
async function createProfile(page: Page, displayName: string): Promise<void> {
  await page.goto('/me/profile');
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill(displayName);
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();
}

test('connections: reachable from the profile nav, statuses and reasons render, setup expands', async ({ page }) => {
  await loginViaOtp(page, EMAIL);
  // The shell needs a profile (/me redirects to the onboarding wizard without
  // one), and the dashboard has to settle before the nav is clicked: straight
  // after the OTP redirect the shell is still re-rendering, and a click during
  // that window races with the element being replaced.
  await createProfile(page, 'Connections Owner');
  await page.goto('/me');
  await waitHydrated(page);

  // Reached from the nav of the authenticated shell, not by typing a URL.
  const nav = page.getByTestId('me-nav');
  await expect(nav).toBeVisible();
  await Promise.all([
    page.waitForURL('**/me/connections'),
    nav.getByRole('link', { name: 'Connections' }).click(),
  ]);
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

/**
 * Phase 2: the two Google providers. This server HAS an OAuth client (see the
 * webServer env in playwright.config.ts), so the cards are live and the controls
 * are real; the unconfigured instance is asserted in
 * tests/integration/connections.test.ts, because a second env configuration would
 * need a second `next dev` sharing one `.next` build directory.
 */
test('connections: the Google cards are live, honest about being unconnected, and explain read vs write', async ({ page }) => {
  await loginViaOtp(page, GOOGLE_EMAIL);
  await createProfile(page, 'Google Owner');
  await page.goto('/me/connections');
  await waitHydrated(page);

  for (const provider of ['google-contacts', 'google-calendar'] as const) {
    const card = page.getByTestId(`provider-${provider}`);
    await expect(card).toHaveAttribute('data-status', 'live');
    await expect(page.getByTestId(`provider-status-${provider}`)).toHaveText('Available');

    // The per-user state is stated: nothing is connected on a fresh account.
    await expect(card.locator(`[data-google-state="not_connected"]`)).toHaveCount(1);
    await expect(card).toContainText('Not connected');

    // A REAL connect control, pointing at the route that starts the handshake.
    const connect = page.getByTestId(`google-connect-${provider}`);
    await expect(connect).toHaveAttribute('href', `/api/oauth/google/start?provider=${provider}`);
    await expect(connect).toBeVisible();

    // No disconnect control without a grant — there is nothing to disconnect.
    await expect(page.getByTestId(`google-disconnect-${provider}`)).toHaveCount(0);

    // Both halves of the privacy statement, per provider.
    await expect(page.getByTestId(`google-reads-${provider}`)).toBeVisible();
    await expect(page.getByTestId(`google-writes-${provider}`)).toBeVisible();
  }

  // The honest, provider-specific wording (never one generic sentence twice).
  await expect(page.getByTestId('google-reads-google-contacts')).toContainText('Names and email addresses');
  await expect(page.getByTestId('google-writes-google-contacts')).toContainText('No contact is created');
  await expect(page.getByTestId('google-reads-google-calendar')).toContainText('We never read your calendar');
  await expect(page.getByTestId('google-writes-google-calendar')).toContainText('sent only if you tick the opt-in');

  // And no OAuth secret can ever reach the browser.
  expect(await page.content()).not.toContain('e2e-client-secret');
});

test('connections: the connect control is inert without a session — no Google flow is started', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Following the connect link signed out must land on the sign-in page: the
  // start route requires a session, so no state, no PKCE and no consent screen.
  await page.goto('/api/oauth/google/start?provider=google-contacts');
  await page.waitForURL('**/login**');
  expect(page.url()).toContain('/login');
  expect(page.url()).not.toContain('accounts.google.com');
  // The sign-in page remembers where the user was going.
  expect(decodeURIComponent(page.url())).toContain('/me/connections');

  // The callback is equally inert: with no session it abandons the flow rather
  // than storing anything, and it never bounces the visitor to Google.
  const callback = await page.goto('/api/oauth/google/callback?code=anything&state=anything');
  expect(callback?.url() ?? page.url()).not.toContain('accounts.google.com');
  expect(decodeURIComponent(page.url())).toContain('/login');

  await context.close();
});

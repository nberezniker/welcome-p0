import { test, expect, type Page } from '@playwright/test';

/**
 * Address-book import on /me/connections (interop §A1): the one thing a user can
 * do with contacts today, with no Google OAuth client involved.
 *
 * The neighbour account is created through the real OTP flow in the same run, so
 * the "already here" answer is a real match against a real account — not a mock.
 */

const NEIGHBOUR_EMAIL = 'contact-neighbour@example.org';
const IMPORTER_EMAIL = 'contact-importer@example.org';
const STRANGER_EMAIL = 'contact-stranger@example.org';

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

async function logout(page: Page): Promise<void> {
  // Ends this browser's session the way the shell does, then drops the cookie so
  // the next sign-in starts clean.
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await page.context().clearCookies();
}

test('contacts import: a known address answers "already here" and links to the card', async ({ page }) => {
  // 1. The neighbour: a real account with a real profile.
  await loginViaOtp(page, NEIGHBOUR_EMAIL);
  await createProfile(page, 'Neighbour Person');
  await logout(page);

  // 2. The importer uploads an address book holding the neighbour and a stranger.
  await loginViaOtp(page, IMPORTER_EMAIL);
  await createProfile(page, 'Importing Person');
  await page.goto('/me/connections');
  await waitHydrated(page);

  const panel = page.getByTestId('contact-import');
  await expect(panel).toBeVisible();
  // The promise is on the panel, next to the action.
  await expect(page.getByTestId('contact-import-note')).toContainText('do not keep your address book');

  const vcf = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Neighbour Person',
    `EMAIL:${NEIGHBOUR_EMAIL}`,
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:3.0',
    'FN:Stranger',
    `EMAIL:${STRANGER_EMAIL}`,
    'END:VCARD',
    '',
  ].join('\r\n');

  await page.getByTestId('contact-import-file').setInputFiles({
    name: 'contacts.vcf',
    mimeType: 'text/vcard',
    buffer: Buffer.from(vcf, 'utf8'),
  });
  const responsePromise = page.waitForResponse(
    (r) => r.url().includes('/api/me/contacts/import') && r.request().method() === 'POST',
  );
  await page.getByTestId('contact-import-submit').click();
  await expect(responsePromise).resolves.toBeTruthy();

  const result = page.getByTestId('contact-import-result');
  await expect(result).toBeVisible();
  await expect(page.getByTestId('contact-import-headline')).toHaveText('1 of your contacts is already here');
  await expect(result.getByTestId('contact-import-match')).toHaveCount(1);
  await expect(result.getByRole('link', { name: 'Neighbour Person' })).toHaveAttribute('href', /^\/p\//);
  await expect(result).toContainText('1 more are not on WELCOME yet.');

  // The response is a list of people: no address is rendered anywhere, and the
  // file input was cleared once the address book had been answered.
  expect(await page.content()).not.toContain(NEIGHBOUR_EMAIL);
  expect(await page.content()).not.toContain(STRANGER_EMAIL);
});

test('contacts import: a file with no addresses is refused in the user\'s own words', async ({ page }) => {
  await loginViaOtp(page, `contact-empty-${Date.now()}@example.org`);
  await createProfile(page, 'Empty Import');
  await page.goto('/me/connections');
  await waitHydrated(page);

  await page.getByTestId('contact-import-text').fill('BEGIN:VCARD\nFN:Nobody\nEND:VCARD');
  await page.getByTestId('contact-import-submit').click();
  await expect(page.getByTestId('contact-import-error')).toHaveText(
    'No contacts with an email address were found in that file.',
  );
  await expect(page.getByTestId('contact-import-result')).toHaveCount(0);
});

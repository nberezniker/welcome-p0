import { test, expect, type Page } from '@playwright/test';

/**
 * Printable QR badge sheet end-to-end: the page opens, the QRs are inline (no
 * network asset), issuing claim links re-points the badges that have no card,
 * and the print stylesheet hides the controls so the sheet itself is what comes
 * out of the printer.
 */

const ORG_EMAIL = 'badges-org@example.org';
const EVENT_SLUG = 'badges-mixer';

const GUEST_CSV = [
  'name,email,external_id,approval_status',
  'Olga Ivanova,olga.ivanova@example.org,b-1,approved',
  'Pavel Smirnov,pavel.smirnov@example.org,b-2,approved',
].join('\n');

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

test('badges: the sheet renders inline QRs and swaps to claim links on demand', async ({ page }) => {
  await loginViaOtp(page, ORG_EMAIL);

  await page.goto('/me/profile');
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill('Badges Owner');
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  await page.goto('/organizer');
  await page.getByTestId('ev-name').fill('E2E Badges Mixer');
  await page.locator('#ev-access').selectOption('public');
  await page.locator('#ev-tz').selectOption('Europe/Madrid');
  await page.locator('#ev-slug').fill(EVENT_SLUG);
  await page.getByTestId('ev-submit').click();
  await page.waitForURL('**/organizer/events/**');
  const eventId = page.url().split('/').pop()!;

  // Import two guests through the real endpoint (same browser session, so the
  // request carries the organizer's cookie).
  const importRes = await page.request.post(`/api/events/${eventId}/imports`, {
    data: { csv_text: GUEST_CSV, mode: 'commit' },
  });
  expect(importRes.status()).toBe(200);

  // Reach the sheet from the event page, the way an organizer would.
  await page.goto(`/organizer/events/${eventId}`);
  await waitHydrated(page);
  await page.getByRole('link', { name: /badge/i }).first().click();
  await page.waitForURL('**/badges');

  const sheet = page.getByTestId('badge-sheet');
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Olga Ivanova')).toBeVisible();
  await expect(page.getByText('Pavel Smirnov')).toBeVisible();

  // Both QRs are inline data URLs — the sheet makes no external request.
  await expect(sheet.locator('img[src^="data:image/svg+xml;base64,"]')).toHaveCount(2);
  // Neither badge has a claim link yet, so they point at the event page.
  await expect(page.locator('[data-qr-url*="/claim/"]')).toHaveCount(0);

  // Issuing claim links re-points both badges in place.
  await page.getByTestId('badges-generate').click();
  await expect(page.locator('[data-qr-url*="/claim/"]')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.getByTestId('toast-success')).toBeVisible();
  // The CSV of claim links becomes downloadable once they exist.
  await expect(page.getByTestId('badges-download-csv')).toBeEnabled();

  // Print preview: the controls disappear, the sheet stays.
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('badges-generate')).toBeHidden();
  await expect(page.getByTestId('badges-print')).toBeHidden();
  await expect(sheet).toBeVisible();
  await expect(page.getByText('Olga Ivanova')).toBeVisible();

  await page.emulateMedia({ media: 'screen' });
  await expect(page.getByTestId('badges-generate')).toBeVisible();
});

import { test, expect, type Page } from '@playwright/test';

/**
 * Organizer funnel (WP2) end-to-end: the block on /organizer/events/[eventId]
 * must render real numbers and the step-to-step conversion after the organizer
 * has actually produced activity — here one joined+directory-visible member and
 * one imported registration, driven through the UI.
 */

const ORG_EMAIL = 'funnel-org@example.org';
const EVENT_SLUG = 'funnel-mixer';

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

test('organizer funnel: shows counted steps, conversion shares and the daily chart', async ({ page }) => {
  await loginViaOtp(page, ORG_EMAIL);

  // Profile through the editor (reached directly; the wizard is pass-B's path).
  await page.goto('/me/profile');
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill('Funnel Owner');
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  // Event via the organizer UI.
  await page.goto('/organizer');
  await page.getByTestId('ev-name').fill('E2E Funnel Mixer');
  await page.locator('#ev-access').selectOption('public');
  await page.locator('#ev-tz').selectOption('Europe/Madrid');
  await page.locator('#ev-slug').fill(EVENT_SLUG);
  await page.getByTestId('ev-submit').click();
  await page.waitForURL('**/organizer/events/**');
  const eventId = page.url().split('/').pop()!;

  // The organizer joins their own event and opts into the directory.
  await page.goto(`/e/${EVENT_SLUG}`);
  await waitHydrated(page);
  await page.getByTestId('join-button').click();
  await expect(page.getByTestId('member-panel')).toBeVisible();
  await waitHydrated(page);
  await page.getByTestId('event-directory-toggle').check();
  await expect(page.getByTestId('event-directory-toggle')).toBeChecked();

  // One imported registration (CSV import panel on the event page).
  await page.goto(`/organizer/events/${eventId}`);
  await page.getByTestId('import-file').setInputFiles({
    name: 'guests.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,email\nFunnel Guest,funnel-guest@example.org\n', 'utf8'),
  });
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-preview-panel')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('import-commit').click();
  await expect(page.getByTestId('import-counts')).toBeVisible({ timeout: 15_000 });

  // Reload: the funnel is server-rendered from the aggregates.
  await page.goto(`/organizer/events/${eventId}`);

  const funnel = page.getByTestId('funnel');
  await expect(funnel).toBeVisible();

  // Numbers, not placeholders.
  await expect(page.getByTestId('funnel-value-registrations')).toHaveText('1');
  await expect(page.getByTestId('funnel-value-activated')).toHaveText('1');
  await expect(page.getByTestId('funnel-value-directory')).toHaveText('1');
  await expect(page.getByTestId('funnel-value-intros')).toHaveText('0');
  await expect(page.getByTestId('funnel-value-mutual')).toHaveText('0');

  // Conversion of each step against the previous one (1→1 = 100%, 1→0 = 0%).
  await expect(page.getByTestId('funnel-share-activated')).toHaveText('100%');
  await expect(page.getByTestId('funnel-share-directory')).toHaveText('100%');
  await expect(page.getByTestId('funnel-share-intros')).toHaveText('0%');
  // intros → mutual has no predecessor value to divide by: a dash, not a made-up 0%/100%.
  await expect(page.getByTestId('funnel-share-mutual')).toHaveCount(0);

  // Wider outcomes render as numbers too (no PII anywhere in the block).
  await expect(page.getByTestId('funnel-metric-claimed')).toContainText('0');
  await expect(page.getByTestId('funnel-metric-declined')).toBeVisible();
  await expect(page.getByTestId('funnel-metric-notes')).toBeVisible();

  // The 30-day chart is drawn inline as SVG (today's registration makes it non-empty).
  const chart = page.getByTestId('funnel-chart');
  await expect(chart).toBeVisible();
  expect(await chart.locator('path').count()).toBe(3);

  await expect(page.getByTestId('funnel-outcomes')).toContainText('Claimed registrations');
});

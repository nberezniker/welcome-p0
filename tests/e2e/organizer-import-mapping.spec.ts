import { test, expect, type Page } from '@playwright/test';

/**
 * CSV import: explicit column mapping end-to-end.
 *
 * The file's headers ("Guest", "Contact") are deliberately outside the
 * documented auto-map candidates, so the preview can only be non-empty AFTER
 * the organizer binds the columns by hand — which is exactly the affordance
 * under test. Recalculating must change the insert/update counters, and the
 * commit must reuse the same mapping.
 */

const ORG_EMAIL = 'mapping-org@example.org';
const EVENT_SLUG = 'mapping-mixer';

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

const CSV = ['Guest,Contact', 'Ivan Petrov,ivan.petrov@example.org', 'Maria Lopez,maria.lopez@example.org'].join('\n');

test('organizer import: mapping a column by hand recalculates the counters', async ({ page }) => {
  await loginViaOtp(page, ORG_EMAIL);

  await page.goto('/me/profile');
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill('Mapping Owner');
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  await page.goto('/organizer');
  await page.getByTestId('ev-name').fill('E2E Mapping Mixer');
  await page.locator('#ev-access').selectOption('public');
  await page.locator('#ev-tz').selectOption('Europe/Madrid');
  await page.locator('#ev-slug').fill(EVENT_SLUG);
  await page.getByTestId('ev-submit').click();
  await page.waitForURL('**/organizer/events/**');
  const eventId = page.url().split('/').pop()!;

  await page.goto(`/organizer/events/${eventId}`);
  await waitHydrated(page);

  // Uploading the file previews it immediately with auto-mapping only.
  await page.getByTestId('import-file').setInputFiles({
    name: 'guests.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV, 'utf8'),
  });

  const mappingPanel = page.getByTestId('import-map-panel');
  await expect(mappingPanel).toBeVisible({ timeout: 15_000 });

  const counts = page.getByTestId('import-map-counts');
  // No column resolves on its own, so nothing is importable yet.
  await expect(counts).toContainText('0');

  // Bind the two columns to fields and recalculate.
  await page.getByTestId('import-map-0').selectOption('name');
  await page.getByTestId('import-map-1').selectOption('email');

  const previewResponse = page.waitForResponse(
    (r) => r.url().includes(`/api/events/${eventId}/imports`) && r.request().method() === 'POST',
  );
  await page.getByTestId('import-map-recalc').click();
  expect((await previewResponse).status()).toBe(200);

  // Both rows are now importable — the counter reflects the manual mapping.
  await expect(counts).toContainText('2');

  // Commit reuses the mapping: the rows land with names from the mapped column.
  await page.getByTestId('import-commit').click();
  await expect(page.getByTestId('import-counts')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('import-counts')).toContainText('2');

  await page.reload();
  await waitHydrated(page);
  await expect(page.getByText('Ivan Petrov')).toBeVisible();
  await expect(page.getByText('Maria Lopez')).toBeVisible();
});

test('organizer import: a duplicate mapping is refused with a readable error', async ({ page }) => {
  await loginViaOtp(page, ORG_EMAIL);

  await page.goto('/organizer');
  await page.getByTestId('ev-name').fill('E2E Mapping Duplicate');
  await page.locator('#ev-access').selectOption('public');
  await page.locator('#ev-tz').selectOption('Europe/Madrid');
  await page.locator('#ev-slug').fill(`${EVENT_SLUG}-dup`);
  await page.getByTestId('ev-submit').click();
  await page.waitForURL('**/organizer/events/**');
  const eventId = page.url().split('/').pop()!;

  await page.goto(`/organizer/events/${eventId}`);
  await waitHydrated(page);
  await page.getByTestId('import-file').setInputFiles({
    name: 'guests.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV, 'utf8'),
  });
  await expect(page.getByTestId('import-map-panel')).toBeVisible({ timeout: 15_000 });

  // Both columns → the same field: the server rejects it and the UI explains why
  // instead of silently importing the wrong column.
  await page.getByTestId('import-map-0').selectOption('name');
  await page.getByTestId('import-map-1').selectOption('name');
  await page.getByTestId('import-map-recalc').click();

  const importError = page.getByTestId('import-error');
  await expect(importError).toBeVisible({ timeout: 15_000 });
  await expect(importError).toContainText('one column');
});

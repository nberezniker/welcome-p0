import { test, expect, type Page } from '@playwright/test';

/**
 * Campaign audience segment (WP3) end-to-end: the segment picker must render in
 * the campaign edit form, the chip selection must persist through save, and the
 * preview must size the SAVED segment (here: nobody but the organizer, who is
 * not a member — so an empty segment of 0 with the honest "all eligible" label).
 */

const ORG_EMAIL = 'segment-org@example.org';
const EVENT_SLUG = 'segment-mixer';

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

test('campaign segment: picker renders, selection is saved and the preview sizes it', async ({ page }) => {
  await loginViaOtp(page, ORG_EMAIL);

  await page.goto('/me/profile');
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill('Segment Owner');
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  await page.goto('/organizer');
  await page.getByTestId('ev-name').fill('E2E Segment Mixer');
  await page.locator('#ev-access').selectOption('public');
  await page.locator('#ev-tz').selectOption('Europe/Madrid');
  await page.locator('#ev-slug').fill(EVENT_SLUG);
  await page.getByTestId('ev-submit').click();
  await page.waitForURL('**/organizer/events/**');
  const eventId = page.url().split('/').pop()!;

  // A service_channel campaign (its audience does not require directory opt-in).
  await page.goto(`/organizer/events/${eventId}/campaigns`);
  await page.locator('#camp-purpose').selectOption('service_channel');
  await page.getByTestId('camp-body').fill('Segment e2e body');
  await page.getByTestId('create-campaign').getByRole('button').first().click();
  await expect(page.getByTestId('create-campaign').getByTestId('toast-success')).toBeVisible();
  const card = page.locator('[data-testid^="campaign-"]').first();
  await expect(card).toBeVisible();

  const campaignId = (await card.getAttribute('data-testid'))!.replace('campaign-', '');

  // The segment lives in the edit form.
  await page.getByTestId(`campaign-edit-${campaignId}`).click();
  const picker = page.getByTestId(`segment-${campaignId}`);
  await expect(picker).toBeVisible();
  await expect(picker.getByText('Audience segment')).toBeVisible();
  // Empty by default → "all eligible".
  await expect(page.getByTestId(`segment-${campaignId}-state`)).toContainText('All eligible');

  // Toggle one interest chip and save.
  const interests = page.getByTestId(`segment-${campaignId}-interests`);
  await interests.getByRole('button').filter({ hasText: /AI|ИИ|IA/i }).first().click();
  await expect(page.getByTestId(`segment-${campaignId}-state`)).toHaveText('');
  const patch = page.waitForResponse(
    (r) => r.url().includes(`/api/organizer/campaigns/${campaignId}`) && r.request().method() === 'PATCH',
  );
  await page.getByTestId(`campaign-save-${campaignId}`).click();
  const patchRes = await patch;
  expect(patchRes.status(), await patchRes.text()).toBe(200);
  // Scoped to the card: the create form keeps its own toast on screen.
  await expect(card.getByTestId('toast-success')).toBeVisible();

  // The saved segment comes back on reload and the preview sizes it.
  await page.reload();
  await page.getByTestId(`campaign-edit-${campaignId}`).click();
  await expect(page.getByTestId(`segment-${campaignId}-state`)).toHaveText('');
  await page.getByTestId(`campaign-segment-preview-${campaignId}`).click();
  const preview = page.getByTestId(`audience-${campaignId}`);
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect(preview).toContainText('Segment:');
  // No participant joined, so the segmented audience is empty — and it says so.
  await expect(page.getByTestId(`audience-segment-${campaignId}`)).toContainText('0');
});

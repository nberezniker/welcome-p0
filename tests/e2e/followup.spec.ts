import { test, expect, type Page } from '@playwright/test';

/**
 * Phase-4 follow-up opt-in, browser-side (design §B5).
 *
 * The running e2e server has `FOLLOWUP_REMINDERS_ENABLED=true` and the digest
 * flag deliberately OFF (see playwright.config.ts). One server therefore proves
 * BOTH halves of the feature-flag rule in the real UI:
 *
 *   - the mechanic whose flag is ON renders a real switch, it round-trips
 *     through the endpoint, and the state survives a reload (persisted, not a
 *     client-side illusion);
 *   - the mechanic whose flag is OFF renders NO switch at all — not a disabled
 *     one — and its endpoint answers 404, so there is nothing to switch on.
 *
 * The "both flags off ⇒ the whole card is absent" case is asserted at the API
 * level in tests/integration/followup-digest.test.ts: it needs a second server
 * started without BOTH flags, and two `next dev` processes for one project
 * directory would share a single `.next` build dir.
 *
 * The reminder switch needs `service_channel` consent, which is why the test
 * grants it first — through the same endpoint the privacy page uses — and the
 * copy that explains the dependency is part of what is asserted.
 */

/** Unique per run: the spec must be re-runnable in one database (local
 *  iterations, --repeat-each) without depending on a migrated-away account. */
const EMAIL = `e2e-followup-${Date.now()}@example.org`;

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

test('follow-up: the switch round-trips and the flag-off mechanic has no switch', async ({ page }) => {
  await loginViaOtp(page, EMAIL);
  expect((await page.request.post('/api/me/profile', { data: { display_name: 'E2E Follow-up', languages: ['en'] } })).status()).toBe(200);
  // The reminder is a service message: it needs the service_channel consent.
  expect(
    (
      await page.request.post('/api/consents', {
        data: { action: 'grant', purpose: 'service_channel', scope_type: 'global', policy_version: '2026-09-p0' },
      })
    ).status(),
  ).toBe(200);

  await page.goto('/me/notes');
  await waitHydrated(page);

  // Flag ON → a real, un-off switch. Off by default, and it says so.
  const card = page.getByTestId('followup-card');
  await expect(card).toBeVisible();
  const reminderToggle = page.getByTestId('followup-toggle-reminders');
  await expect(reminderToggle).toBeVisible();
  await expect(reminderToggle).toBeEnabled();
  await expect(reminderToggle).not.toBeChecked();
  await expect(page.getByTestId('followup-state-reminders')).toHaveText('Off');
  await expect(card).toContainText('off by default');
  await expect(card).toContainText('How to stop');
  // The delay in the copy is the CONFIGURED one, not a hardcoded week.
  await expect(card).toContainText('7 days');

  // Flag OFF → no switch exists at all for that mechanic.
  await expect(page.getByTestId('followup-digest')).toHaveCount(0);
  await expect(page.getByTestId('followup-toggle-digest')).toHaveCount(0);

  // Switch it on: the endpoint confirms, the toast confirms, the chip flips.
  const onResponse = page.waitForResponse((r) => r.url().includes('/api/me/followup') && r.request().method() === 'POST');
  await reminderToggle.check();
  expect(((await (await onResponse).json()) as { opted_in: boolean }).opted_in).toBe(true);
  await expect(page.getByTestId('toast-success')).toBeVisible();
  await expect(page.getByTestId('followup-state-reminders')).toHaveText('On');

  // Persisted server-side (not just in the DOM)…
  const stateRes = await page.request.get('/api/me/followup');
  expect(stateRes.status()).toBe(200);
  const state = (await stateRes.json()) as {
    enabled: { reminders: boolean; digest: boolean };
    opted_in: { reminders: boolean; digest: boolean };
    consent: { service_channel: boolean; digest_weekly: boolean };
  };
  expect(state.enabled).toEqual({ reminders: true, digest: false });
  expect(state.opted_in.reminders).toBe(true);
  expect(state.consent.service_channel).toBe(true);

  // …and survives a reload.
  await page.reload();
  await waitHydrated(page);
  await expect(page.getByTestId('followup-toggle-reminders')).toBeChecked();
  await expect(page.getByTestId('followup-state-reminders')).toHaveText('On');

  // The flag-off mechanic is not reachable through the API either.
  const digestPost = await page.request.post('/api/me/followup', { data: { mechanic: 'digest', opted_in: true } });
  expect(digestPost.status()).toBe(404);
  expect(((await digestPost.json()) as { code: string }).code).toBe('feature_disabled');

  // Switching back off is also round-tripped, and the stored state follows.
  const offResponse = page.waitForResponse((r) => r.url().includes('/api/me/followup') && r.request().method() === 'POST');
  await page.getByTestId('followup-toggle-reminders').uncheck();
  expect(((await (await offResponse).json()) as { opted_in: boolean }).opted_in).toBe(false);
  await expect(page.getByTestId('followup-state-reminders')).toHaveText('Off');
  const offRes = await page.request.get('/api/me/followup');
  expect(((await offRes.json()) as { opted_in: { reminders: boolean } }).opted_in.reminders).toBe(false);
});

test('follow-up: the switch does not exist before service_channel is allowed', async ({ page }) => {
  // A second account that never granted the service-channel consent: the switch
  // is rendered DISABLED with the reason, instead of silently doing nothing when
  // it is flipped.
  const email = `e2e-followup-noconsent-${Date.now()}@example.org`;
  await loginViaOtp(page, email);
  expect((await page.request.post('/api/me/profile', { data: { display_name: 'E2E No Consent', languages: ['en'] } })).status()).toBe(200);

  await page.goto('/me/notes');
  await waitHydrated(page);

  await expect(page.getByTestId('followup-toggle-reminders')).toBeDisabled();
  await expect(page.getByTestId('followup-consent-hint-reminders')).toBeVisible();
  await expect(page.getByTestId('followup-consent-hint-reminders')).toContainText('service messages');
});

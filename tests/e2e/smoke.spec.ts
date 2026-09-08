import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * E2E smoke (Phase 4): one spec covering the core P0 loop.
 * Runs against `next dev` (see playwright.config.ts) on the welcome_e2e DB.
 * OTP devCode is read from the request response (AUTH_DEV_EXPOSE_OTP=true).
 */

const A_EMAIL = 'alice@example.org';
const B_EMAIL = 'bob@example.org';
const EVENT_SLUG = 'e2e-mixer';

/** Client JS is live once the layout's HydrationMarker has run. */
async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

/** Sign in through the two-step OTP UI; returns the devCode for assertions. */
async function loginViaOtp(page: Page, email: string): Promise<string> {
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
  expect(body.ok).toBe(true);
  if (!body.devCode) throw new Error('devCode missing from OTP request response');
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL('**/me');
  return body.devCode;
}

/** Creates the profile via the editor UI. */
async function createProfile(page: Page, displayName: string, headline: string, offerTag: string, needTag: string) {
  await page.goto('/me/profile');
  await page.getByTestId('pf-name').fill(displayName);
  await page.locator('#pf-headline').fill(headline);
  await page.locator('#pf-offer').fill(offerTag);
  await page.keyboard.press('Enter');
  await page.locator('#pf-need').fill(needTag);
  await page.keyboard.press('Enter');
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();
}

/** Upserts a contact via the contacts UI. */
async function addContact(page: Page, kind: string, value: string, publish: boolean) {
  await page.goto('/me/contacts');
  await page.locator(`#contact-value-${kind}`).fill(value);
  if (publish) await page.locator(`#contact-public-${kind}`).check();
  else await page.locator(`#contact-public-${kind}`).uncheck();
  await page.getByTestId(`contact-save-${kind}`).click();
  await expect(page.getByTestId('toast-success')).toBeVisible();
}

async function newContext(browser: import('@playwright/test').Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 1280, height: 900 } });
}

test.describe('WELCOME P0 smoke', () => {
  test('landing, OTP login, profile, public card, event directory, mutual intro reveal', async ({ page, browser }) => {
    // ── 1. Landing renders; locale switch works ─────────────────────────────
    await page.goto('/');
    await waitHydrated(page);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('One QR.');
    await expect(page.getByTestId('locale-switcher')).toBeVisible();
    await page.getByTestId('locale-switcher').getByRole('button', { name: /RU/i }).click();
    await page.waitForTimeout(4000);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Один QR.');
    await waitHydrated(page); // page reloaded — wait for client JS again
    await page.getByTestId('locale-switcher').getByRole('button', { name: /: EN/i }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('One QR.');

    // No horizontal overflow at 360px.
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/');
    const overflow360 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow360).toBeLessThanOrEqual(1);

    // ── 2. Account A: OTP login ─────────────────────────────────────────────
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginViaOtp(page, A_EMAIL);
    await expect(page.getByTestId('create-profile-cta')).toBeVisible();

    // ── 3. Account A creates profile ────────────────────────────────────────
    await createProfile(page, 'Alice Nova', 'Backend engineer', 'pilot-integrations', 'saas-distribution');
    await expect(page.locator('#pf-name')).toHaveValue('Alice Nova');

    // Contacts: whatsapp published, phone private.
    await addContact(page, 'whatsapp', '+34600111111', true);
    await addContact(page, 'phone', '+34600222222', false);

    // Dashboard shows public URL + QR.
    await page.goto('/me');
    await expect(page.getByTestId('dashboard-title')).toContainText('Alice Nova');
    const publicUrl = await page.getByTestId('public-url').textContent();
    expect(publicUrl).toContain('/p/');

    // ── 4. Public card in a FRESH context (no session) ──────────────────────
    const anon = await newContext(browser);
    const anonPage = await anon.newPage();
    await anonPage.goto(publicUrl!);
    await expect(anonPage.getByRole('heading', { level: 1 })).toContainText('Alice Nova');
    await expect(anonPage.getByText('+34600111111')).toBeVisible(); // published contact visible
    await expect(anonPage.getByText('+34600222222')).toHaveCount(0); // private contact absent
    await anon.close();

    // ── 5. Account A creates an event via organizer UI ──────────────────────
    await page.goto('/organizer');
    await page.getByTestId('ev-name').fill('E2E Founders Mixer');
    await page.locator('#ev-access').selectOption('public');
    await page.locator('#ev-tz').selectOption('Europe/Madrid');
    await page.locator('#ev-slug').fill(EVENT_SLUG);
    await page.getByTestId('ev-submit').click();
    await page.waitForURL('**/organizer/events/**');
    const eventUrl = page.url();
    const eventId = eventUrl.split('/').pop()!;

    // A joins own event and opts into the directory.
    await page.goto(`/e/${EVENT_SLUG}`);
    await waitHydrated(page);
    await page.getByTestId('join-button').click();
    await expect(page.getByTestId('member-panel')).toBeVisible(); // reload after join
    await waitHydrated(page);
    await page.getByTestId('event-directory-toggle').check();
    await expect(page.getByTestId('event-directory-toggle')).toBeChecked();

    // ── 6. Account B: login, profile, contact, join, directory ─────────────
    const ctxB = await newContext(browser);
    const pageB = await ctxB.newPage();
    await loginViaOtp(pageB, B_EMAIL);
    await createProfile(pageB, 'Bob Marlow', 'Growth advisor', 'saas-distribution', 'pilot-integrations');
    await addContact(pageB, 'whatsapp', '+34600333333', true);

    await pageB.goto(`/e/${EVENT_SLUG}`);
    await waitHydrated(pageB);
    await pageB.getByTestId('join-button').click();
    await expect(pageB.getByTestId('member-panel')).toBeVisible(); // reload after join
    await waitHydrated(pageB);
    await pageB.getByTestId('event-directory-toggle').check();
    await expect(pageB.getByTestId('event-directory-toggle')).toBeChecked();

    // ── 7. B opens the directory and proposes an intro to A ────────────────
    await pageB.goto(`/me/events/${eventId}/directory`);
    const memberCard = pageB.getByTestId('member-list').locator('li').first();
    await memberCard.getByRole('button').first().click(); // propose intro
    await pageB.locator('input[type=checkbox]').first().check(); // reveal whatsapp
    await pageB.getByTestId('send-intro').click();
    await expect(pageB.getByTestId('toast-success')).toBeVisible();

    // ── 8. A accepts, then B accepts (mutual needs BOTH accepts) ────────────
    await page.goto('/me/introductions');
    await waitHydrated(page);
    await page.locator('fieldset input[type=checkbox]').first().check(); // reveal whatsapp
    await page.getByRole('button', { name: 'Accept' }).click();

    await pageB.goto('/me/introductions');
    await waitHydrated(pageB);
    await pageB.locator('fieldset input[type=checkbox]').first().check(); // reveal whatsapp
    await pageB.getByRole('button', { name: 'Accept' }).click();

    // Both sides reload and see the revealed field.
    await page.reload();
    await expect(page.locator('[data-testid^="intro-revealed"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('+34600333333')).toBeVisible(); // B's whatsapp revealed to A

    await pageB.reload();
    await expect(pageB.getByText('+34600111111')).toBeVisible(); // A's whatsapp revealed to B

    await ctxB.close();
  });

  // F-04: the security header set must be present on page routes. The rest of
  // the smoke (hydration marker, locale switch, OTP flow) doubles as the proof
  // that the CSP does not break the Next.js client bootstrap.
  // F-15: the legal pages render and count as page routes.
  test('security headers on /, /login and legal pages (F-04, F-15)', async ({ page }) => {
    for (const path of ['/', '/login', '/legal/privacy', '/legal/terms']) {
      const res = await page.goto(path);
      expect(res?.status(), `GET ${path}`).toBe(200);
      const h = res?.headers() ?? {};
      expect(h['content-security-policy'], `CSP on ${path}`).toContain("default-src 'self'");
      expect(h['content-security-policy'], `CSP on ${path}`).toContain("frame-ancestors 'none'");
      expect(h['content-security-policy'], `CSP on ${path}`).toContain("object-src 'none'");
      expect(h['x-frame-options'], `XFO on ${path}`).toBe('DENY');
      expect(h['referrer-policy'], `Referrer-Policy on ${path}`).toBe('strict-origin-when-cross-origin');
      expect(h['permissions-policy'], `Permissions-Policy on ${path}`).toContain('camera=()');
    }
  });
});

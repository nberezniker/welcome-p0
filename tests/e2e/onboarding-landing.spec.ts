import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Pass B e2e: a brand-new account goes through the onboarding wizard and ends on
 * its own mini-landing — which is then opened in a CLEAN context (no session) to
 * prove that (a) the card is public and (b) private data is not on it.
 *
 * Screenshots for the evidence folder are written from inside the spec (the
 * Playwright config keeps automatic screenshots off).
 */

const EMAIL = 'onboarding-e2e@example.org';
const PRIVATE_PHONE = '+34600999888';
const SCREENSHOTS = 'evidence/screenshots';

/** Client JS is live once the layout's HydrationMarker has run. */
async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

async function loginViaOtp(page: Page, email: string) {
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
}

async function newContext(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<BrowserContext> {
  return browser.newContext({ viewport });
}

test('onboarding (3 questions) → mini-landing is public, localized and free of private data', async ({
  page,
  browser,
}) => {
  // ── 1. A new account lands in the wizard: /me redirects a profile-less user ─
  await page.goto('/');
  await loginViaOtp(page, EMAIL);
  await page.waitForURL(/\/onboarding$/, { timeout: 30_000 });
  await waitHydrated(page);
  await expect(page.getByTestId('onboarding-progress')).toContainText('1');
  await expect(page.getByTestId('onboarding-step1')).toBeVisible();

  // ── 2. Question 1: who you are ─────────────────────────────────────────────
  await page.getByTestId('ob-name').fill('Olga Landing');
  await page.locator('#ob-headline').fill('Founder of Solbeam');
  await page.locator('#ob-company').fill('Solbeam Labs');
  await page.getByTestId('ob-function').selectOption('founder-ceo');
  await page.getByTestId('ob-industry').selectOption('ai-saas');
  await page.screenshot({ path: `${SCREENSHOTS}/onboarding-step1.png`, fullPage: true });
  await page.getByTestId('ob-next').click();

  // ── 3. Question 2: what you are looking for ────────────────────────────────
  await expect(page.getByTestId('onboarding-step2')).toBeVisible();
  await page.getByTestId('ob-needs-seeking-cofounder').click();
  await page.getByTestId('ob-interests-ai-ml').click();
  // The limit is announced, not silently enforced.
  await expect(page.getByTestId('ob-needs')).toContainText('1/3');
  await page.getByTestId('ob-next').click();

  // ── 4. Question 3: how you can help ────────────────────────────────────────
  await expect(page.getByTestId('onboarding-step3')).toBeVisible();
  await page.getByTestId('ob-offers-offering-services').click();
  await page.getByTestId('ob-keywords-input').fill('solar');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('ob-keywords')).toContainText('1/5');
  await page.getByTestId('ob-next').click();

  // ── 5. Confirmation: links + publish opt-outs, then publish ────────────────
  await expect(page.getByTestId('onboarding-step4')).toBeVisible();
  await expect(page.getByTestId('ob-enrich')).toBeVisible();
  await page.getByTestId('ob-link-telegram_username').fill('@olga_e2e');
  // A malformed link is reported inline, before anything is saved.
  await page.getByTestId('ob-link-github_url').fill('https://example.com/not-github');
  await expect(page.locator('.field-error').first()).toBeVisible();
  await page.getByTestId('ob-link-github_url').fill('');
  // Two fields stay off the card.
  await page.getByTestId('ob-publish-company').uncheck();
  await page.getByTestId('ob-publish-keywords').uncheck();
  await page.screenshot({ path: `${SCREENSHOTS}/onboarding-step4.png`, fullPage: true });

  await page.getByTestId('ob-publish').click();
  await page.waitForURL(/\/p\/[A-Za-z0-9_-]+$/, { timeout: 30_000 });
  const cardPath = new URL(page.url()).pathname;
  await expect(page.getByTestId('pubcard-name')).toHaveText('Olga Landing');

  // ── 6. A PRIVATE phone is added afterwards: it must never reach the card ────
  await page.goto('/me/contacts');
  await waitHydrated(page);
  await page.locator('#contact-value-phone').fill(PRIVATE_PHONE);
  await page.locator('#contact-public-phone').uncheck();
  await page.getByTestId('contact-save-phone').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  // ── 7. The same card in a CLEAN context (no session) ───────────────────────
  const anon = await newContext(browser, { width: 360, height: 780 });
  const anonPage = await anon.newPage();
  await anonPage.goto(cardPath);

  await expect(anonPage.getByTestId('pubcard-name')).toHaveText('Olga Landing');
  await expect(anonPage.getByTestId('pubcard')).toContainText('Founder of Solbeam');
  // Intent and interest are on the card, rendered from the catalogue as labels.
  await expect(anonPage.getByTestId('pubcard-needs')).toContainText(/co-founder/i);
  await expect(anonPage.getByTestId('pubcard-interests')).toContainText(/AI/i);
  await expect(anonPage.getByTestId('pubcard-offers')).toContainText(/service/i);

  // Private phone: absent from the HTML…
  await expect(anonPage.getByText(PRIVATE_PHONE)).toHaveCount(0);
  // …and absent from the public JSON as well.
  const json = await anonPage.request.get(`/api/public/profiles${cardPath.replace('/p/', '/')}`);
  expect(json.status()).toBe(200);
  const payload = (await json.json()) as { contacts: { kind: string; value: string }[]; company: string | null };
  expect(JSON.stringify(payload)).not.toContain(PRIVATE_PHONE);
  expect(payload.contacts.some((c) => c.kind === 'phone')).toBe(false);

  // The unticked fields are gone from the card, not merely styled out.
  await expect(anonPage.getByText('Solbeam Labs')).toHaveCount(0);
  await expect(anonPage.getByTestId('pubcard-expertise')).toHaveCount(0);
  expect(payload.company).toBeNull();

  // The confirmed Telegram link is there, with a safe rel.
  const telegram = anonPage.locator('a[href="https://t.me/olga_e2e"]');
  await expect(telegram).toBeVisible();
  await expect(telegram).toHaveAttribute('rel', /noopener/);

  // Shareable meta tags.
  await expect(anonPage.locator('meta[property="og:title"]')).toHaveAttribute('content', /Olga Landing/);

  // Anonymous visitors get the sign-in CTA, never an introduction form.
  await expect(anonPage.getByTestId('pubcard-signin-cta')).toBeVisible();
  await expect(anonPage.getByTestId('pubcard-intro-cta')).toHaveCount(0);

  // Mobile narrow viewport: no horizontal overflow.
  const overflow = await anonPage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await anonPage.screenshot({ path: `${SCREENSHOTS}/mini-landing-360.png`, fullPage: true });
  await anon.close();

  // ── 8. Desktop screenshot of the card ──────────────────────────────────────
  const desktop = await newContext(browser);
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(cardPath);
  await expect(desktopPage.getByTestId('pubcard-name')).toBeVisible();
  await desktopPage.screenshot({ path: `${SCREENSHOTS}/mini-landing-1280.png`, fullPage: true });
  await desktop.close();
});

test('the onboarding draft survives a reload and /me/profile edits the axes', async ({ page, browser }) => {
  const email = 'onboarding-draft-e2e@example.org';
  await page.goto('/login');
  await waitHydrated(page);
  await loginViaOtp(page, email);
  await page.waitForURL(/\/onboarding$/, { timeout: 30_000 });
  await waitHydrated(page);
  await page.getByTestId('ob-name').fill('Draft Person');
  await page.getByTestId('ob-next').click();
  await expect(page.getByTestId('onboarding-step2')).toBeVisible();

  // The draft is local, so a reload comes back to the same step with the value.
  await page.reload();
  await waitHydrated(page);
  await expect(page.getByTestId('onboarding-draft-restored')).toBeVisible();
  await expect(page.getByTestId('onboarding-step2')).toBeVisible();

  // Publish from step 2 (the wizard allows it) and edit the axes in the profile.
  await page.getByTestId('ob-needs-seeking-cofounder').click();
  await page.getByTestId('ob-next').click();
  await page.getByTestId('ob-next').click();
  await page.getByTestId('ob-publish').click();
  await page.waitForURL(/\/p\/[A-Za-z0-9_-]+$/, { timeout: 30_000 });

  await page.goto('/me/profile');
  await waitHydrated(page);
  await expect(page.getByTestId('pf-needs-selected-seeking-cofounder')).toBeVisible();
  await page.getByTestId('pf-offers-open-to-cofound').click();
  await page.getByTestId('pf-publish-headline').uncheck();
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  // The saved axes are reflected on the public card.
  await page.goto('/me');
  await waitHydrated(page);
  const publicUrl = await page.getByTestId('public-url').textContent();
  const cardPath = new URL(publicUrl!.trim()).pathname;
  const anon = await newContext(browser);
  const anonPage = await anon.newPage();
  await anonPage.goto(cardPath);
  await expect(anonPage.getByTestId('pubcard-offers')).toContainText(/co-found/i);
  await anon.close();
});

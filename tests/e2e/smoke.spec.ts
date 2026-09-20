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
  // A profile-less account is redirected from /me into the onboarding wizard
  // (pass B); an account that already has a profile stays on /me.
  await page.waitForURL(/\/(me|onboarding)$/, { timeout: 30_000 });
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

/**
 * Opt into the event directory and CONFIRM THE SERVER ACCEPTED IT.
 *
 * `event-directory-toggle` is an optimistic control: React flips the checkbox
 * before the PATCH is answered (src/app/e/[slug]/member-panel.tsx). Asserting
 * only the DOM therefore cannot tell "saved" from "dropped", and everything
 * downstream depends on the row actually being `directory_visible = true`.
 * The write is confirmed against its own response, so a lost PATCH fails HERE
 * with the status that caused it instead of surfacing three steps later as an
 * empty directory.
 */
async function joinDirectory(page: Page) {
  const toggle = page.getByTestId('event-directory-toggle');
  // Fresh membership: migration 001 defaults directory_visible to false.
  await expect(toggle, 'the toggle starts unchecked for a new membership').not.toBeChecked();
  const patched = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes('/api/me/memberships/'),
  );
  await toggle.check();
  const res = await patched;
  expect(res.status(), 'directory_visible must be persisted server-side').toBe(200);
  await expect(toggle).toBeChecked();
}

/**
 * Switches the directory to "Everyone" and waits for the ANSWER, not for a
 * clock: `member-list` only renders when the directory API returns at least one
 * other visible member, and the panel renders `directory-empty` for any
 * non-OK response. Asserting the visible list alone conflates "the request
 * failed" (403/404/500) with "nobody is visible" and reports both as a DOM
 * timeout. The response is asserted first, so the real cause is named; the DOM
 * assertion then only covers the render, which is why it needs no fixed wait.
 */
async function openDirectoryAllMode(page: Page, eventId: string): Promise<string[]> {
  const answered = page.waitForResponse(
    (r) =>
      r.request().method() === 'GET' &&
      r.url().includes(`/api/events/${eventId}/directory`) &&
      r.url().includes('mode=all'),
    // Bounds the click taking effect (the effect refetches on the mode change),
    // not the API call: the response itself is awaited below, unbounded.
    { timeout: 30_000 },
  );
  await page.getByTestId('dir-mode-all').click();
  const res = await answered;
  expect(res.status(), 'GET directory?mode=all').toBe(200);
  const body = (await res.json()) as { members?: { display_name: string }[] };
  const names = (body.members ?? []).map((m) => m.display_name);
  await expect(page.getByTestId('member-list')).toBeVisible();
  return names;
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
    // No profile yet → the wizard owns the first-run path (pass B).
    await expect(page).toHaveURL(/\/onboarding$/);

    // ── 3. Account A creates profile through the editor ─────────────────────
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
    await joinDirectory(page);

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
    // Confirms the PATCH before step 7 navigates this page away: `goto` aborts
    // whatever is still in flight, so an unconfirmed optimistic write here is a
    // write that can be silently lost.
    await joinDirectory(pageB);

    // ── 7. B opens the directory and proposes an intro to A ────────────────
    await pageB.goto(`/me/events/${eventId}/directory`);
    // Pass B: the directory defaults to intent mode ("they seek what I offer"),
    // which is honestly empty for these tag-only profiles — switch to "Everyone".
    await waitHydrated(pageB);
    const visible = await openDirectoryAllMode(pageB, eventId);
    // The list is asserted against the API's own answer: A must be visible to B.
    expect(visible).toContain('Alice Nova');
    const memberCard = pageB.getByTestId('member-list').locator('li').first();
    await memberCard.getByRole('button').first().click(); // propose intro
    await pageB.locator('input[type=checkbox]').first().check(); // reveal whatsapp
    await pageB.getByTestId('send-intro').click();
    await expect(pageB.getByTestId('toast-success')).toBeVisible();

    // ── 8. B (the INITIATOR) opens the card: it must be the WAITING view ────
    // Requesting IS consenting (ADR 0010), so the initiator is never asked to
    // accept their own request — no accept/decline buttons, only Withdraw.
    await pageB.goto('/me/introductions');
    await waitHydrated(pageB);
    await expect(pageB.locator('[data-testid^="intro-state"]').first()).toHaveText(/Waiting for response/);
    await expect(pageB.locator('[data-testid^="intro-withdraw"]').first()).toBeVisible();
    await expect(pageB.locator('[data-testid^="intro-accept"]')).toHaveCount(0);
    await expect(pageB.locator('[data-testid^="intro-decline"]')).toHaveCount(0);

    // ── 9. A (the counterparty) answers ONCE — that completes the pair ──────
    await page.goto('/me/introductions');
    await waitHydrated(page);
    await page.locator('fieldset input[type=checkbox]').first().check(); // reveal whatsapp
    // The reload below must not race an in-flight accept POST (it aborts the
    // request and the decision rolls back) — wait for the response first.
    const acceptA = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/respond'));
    await page.getByRole('button', { name: 'Accept' }).click();
    await acceptA;

    // Both sides reload and see the revealed field.
    await page.reload();
    await expect(page.locator('[data-testid^="intro-revealed"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('+34600333333')).toBeVisible(); // B's whatsapp revealed to A

    await pageB.reload();
    await expect(pageB.getByText('+34600111111')).toBeVisible(); // A's whatsapp revealed to B

    await ctxB.close();
  });

  // R1: `?lang=` on the public pages (locale query override + cookie).
  // A shared link can carry the language and the choice survives the visit;
  // without the parameter (or with an invalid one) nothing changes.
  test('?lang= switches the landing language and is remembered (R1)', async ({ page, browser }) => {
    const res = await page.goto('/?lang=ru');
    expect(res?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Один QR.');

    // The choice is persisted: the plain landing URL is Russian now.
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Один QR.');

    // A fresh visitor with an invalid value keeps the English default.
    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();
    await freshPage.goto('/?lang=de');
    await expect(freshPage.locator('html')).toHaveAttribute('lang', 'en');
    await expect(freshPage.getByRole('heading', { level: 1 })).toContainText('One QR.');
    await freshPage.goto('/');
    await expect(freshPage.locator('html')).toHaveAttribute('lang', 'en');
    await fresh.close();
  });

  // F-04: the security header set must be present on page routes. The rest of
  // the smoke (hydration marker, locale switch, OTP flow) doubles as the proof
  // that the CSP does not break the Next.js client bootstrap.
  // F-15: the legal pages render and count as page routes.
  // X-Content-Type-Options is asserted here rather than only in the config unit
  // test (tests/unit/security-headers.test.ts) because that one proves what the
  // app DECLARES; this proves the header survives the dev server and the
  // streaming HTML response. Strict-Transport-Security is asserted there as a
  // deliberate ABSENCE — the platform that terminates TLS owns it, see the
  // comment in next.config.ts.
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
      expect(h['x-content-type-options'], `nosniff on ${path}`).toBe('nosniff');
    }
  });

  // SEO surface: /robots.txt keeps crawlers out of the signed-in areas and the
  // API, and points at the sitemap on the canonical origin — the same
  // APP_BASE_URL the page metadata uses, so the file can never advertise a host
  // this deployment does not serve. /sitemap.xml lists the public pages ONLY:
  // a user card or an event URL in there would hand a crawler a page that is
  // nobody else's business, which is the one thing this product promises not to
  // do (landing, "no scraping").
  test('robots.txt and sitemap.xml expose only the public surface (SEO)', async ({ request }) => {
    const robotsRes = await request.get('/robots.txt');
    expect(robotsRes.status(), 'GET /robots.txt').toBe(200);
    const robots = await robotsRes.text();
    // The origin the files claim is read off the answer itself rather than typed
    // in: it is `APP_BASE_URL` as the running server resolved it, which is the
    // whole point of building these URLs from the config (a hardcoded host would
    // fail here, and would be wrong for every fork).
    const origin = new URL(robotsRes.url()).origin;

    expect(robots).toContain('User-Agent: *');
    expect(robots).toContain('Allow: /');
    for (const blocked of ['/me/', '/organizer/', '/api/']) {
      expect(robots, `Disallow ${blocked}`).toContain(`Disallow: ${blocked}`);
    }
    expect(robots, 'the sitemap URL must come from the configured origin').toContain(
      `Sitemap: ${origin}/sitemap.xml`,
    );

    const sitemapRes = await request.get('/sitemap.xml');
    expect(sitemapRes.status(), 'GET /sitemap.xml').toBe(200);
    const sitemap = await sitemapRes.text();
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.sort(), 'only the landing and the two legal pages are public').toEqual(
      [`${origin}/`, `${origin}/legal/privacy`, `${origin}/legal/terms`].sort(),
    );
    // Belt and braces: nothing private-shaped anywhere in the document, including
    // in an attribute rather than a <loc>.
    for (const forbidden of ['/me', '/organizer', '/api', '/p/', '/e/']) {
      expect(sitemap, `${forbidden} must not be listed`).not.toContain(forbidden);
    }
  });
});

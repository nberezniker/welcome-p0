import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { en, type Dictionary } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/**
 * THE OWNER'S OWN CARD, AND THE THREE STATES BESIDE IT.
 *
 * THE DEFECT THIS FILE PINS. Opening your own card while signed in rendered the
 * introduction affordance, because `findSharedEvent` (src/lib/public-profile.ts)
 * resolves "do these two share an event" with a self-join: the viewer and the
 * target were the same profile, so the card believed a shared event existed and
 * handed the introduction button the viewer's own profile id. Pressing it made
 * `POST /api/introductions` answer `400 self_intro`, behind the generic
 * "Something went wrong" toast — an affordance whose only possible outcome was an
 * error. Observed live before the fix: `intro=1 noconnection=0 signin=0` on the
 * owner's card, `400 {"code":"self_intro"}` on the send.
 *
 * WHY IT IS DRIVEN IN A BROWSER. The defect is a state the SERVER chose, and the
 * three states around it depend on the viewer: the unit suite can only pin the
 * branch and the copy (`tests/unit/pubcard-cta-states.test.ts`), while which one
 * a real signed-in person actually gets — including the self-join case, which
 * needs a membership, an event and a session — is only observable here.
 *
 * WHAT IS ASSERTED, STATE BY STATE, WITH THE NEGATIVES:
 *   1. the OWNER, before joining anything and after joining their own event:
 *      their card says it is theirs, offers the editor, keeps the share and QR
 *      controls below, and renders NO introduction, NO sign-in and NOT the
 *      "nothing to connect here yet" state that belongs to somebody else's card;
 *   2. the SERVER still refuses the request the UI no longer offers: a forced
 *      `POST /api/introductions` with the owner's own profile id is `400
 *      self_intro` — the UI is not the only defence;
 *   3. a signed-in member who SHARES the event: still the introduction;
 *   4. a signed-in visitor with no shared event: still the honest no-connection
 *      state;
 *   5. an anonymous visitor: still the sign-in CTA, and never the owner's state.
 * The dictionary is the oracle for the copy in all three languages, so a locale
 * that silently rendered English fails here.
 */

const OWNER_EMAIL = 'own-card-owner@example.org';
const NEIGHBOUR_EMAIL = 'own-card-neighbour@example.org';
const STRANGER_EMAIL = 'own-card-stranger@example.org';
const OWNER_NAME = 'Own Card Owner';
const NEIGHBOUR_NAME = 'Own Card Neighbour';
const EVENT_SLUG = 'e2e-own-card';
const MOBILE = { width: 390, height: 844 };

const DICTS: Record<'en' | 'ru' | 'es', Partial<Dictionary>> = { en, ru, es };

/** The locale's copy for a key, or a failure — a missing key must never compare
 * equal to an empty string and pass. */
function copy(locale: 'en' | 'ru' | 'es', key: keyof Dictionary): string {
  const value = DICTS[locale][key];
  if (value === undefined) throw new Error(`${locale} has no ${String(key)}`);
  return value;
}

async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

async function loginViaOtp(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await waitHydrated(page);
  await page.getByTestId('login-email').fill(email);
  const requested = page.waitForResponse(
    (r) => r.url().includes('/api/auth/otp/request') && r.request().method() === 'POST',
  );
  await page.getByTestId('login-request').click();
  const body = (await (await requested).json()) as { devCode?: string };
  if (!body.devCode) throw new Error('devCode missing from the OTP request response');
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL(/\/(me|onboarding)$/, { timeout: 30_000 });
}

/** A profile through the public API — a fixture, not the thing under test. */
async function seedProfile(page: Page, displayName: string): Promise<void> {
  const res = await page.request.post('/api/me/profile', {
    data: { display_name: displayName, languages: ['en'] },
  });
  expect(res.status(), `profile for ${displayName}: ${await res.text()}`).toBe(200);
}

/** The card's path, read off the dashboard the way its owner reads it. */
async function cardPath(page: Page): Promise<string> {
  await page.goto('/me');
  await waitHydrated(page);
  const url = (await page.getByTestId('public-url').textContent())?.trim() ?? '';
  expect(url, 'the dashboard must show the public card URL').toContain('/p/');
  return new URL(url).pathname;
}

/** Joins the event through the join button and makes the member visible. */
async function joinEvent(page: Page, slug: string): Promise<void> {
  await page.goto(`/e/${slug}`);
  await waitHydrated(page);
  await page.getByTestId('join-button').click();
  await expect(page.getByTestId('member-panel')).toBeVisible({ timeout: 30_000 });
  await waitHydrated(page);
  const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/me/memberships/'));
  await page.getByTestId('event-directory-toggle').check();
  expect((await patched).status()).toBe(200);
}

/** The four card states, by their testids. Absence is as much of the claim as presence. */
const STATE_TESTIDS = [
  'pubcard-owncard-cta',
  'pubcard-intro-cta',
  'pubcard-noconnection-cta',
  'pubcard-signin-cta',
] as const;

async function presentStates(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const testid of STATE_TESTIDS) {
    if ((await page.getByTestId(testid).count()) > 0) out.push(testid);
  }
  return out;
}

test('own card: the owner is told it is their card, and the three other states are unchanged', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const contexts: BrowserContext[] = [];
  try {
    // ── The owner: profile, event, card ──────────────────────────────────────
    await page.setViewportSize(MOBILE);
    await loginViaOtp(page, OWNER_EMAIL);
    await seedProfile(page, OWNER_NAME);
    const created = await page.request.post('/api/organizer/events', {
      data: { name: 'E2E Own Card', slug: EVENT_SLUG, mode: 'offline', access_mode: 'public', timezone: 'UTC' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const event = ((await created.json()) as { event: { id: string; slug: string } }).event;
    const path = await cardPath(page);

    // ── 1a. BEFORE joining anything: still the owner's own card ──────────────
    // This is the case that used to fall through to "nothing to connect here
    // yet" — a sentence about somebody else's card, said to its author.
    await page.goto(path);
    await waitHydrated(page);
    await expect(page.getByTestId('pubcard-owncard-cta'), 'the owner’s card says it is theirs').toBeVisible();
    await expect(page.getByTestId('pubcard-noconnection-cta'), 'an own card is not an empty stranger’s card').toHaveCount(0);
    const own = page.getByTestId('pubcard-owncard-cta');
    await expect(own.getByTestId('pubcard-owncard-text')).toHaveText(en['pubcard.ctaOwnCard']);
    await expect(own).toContainText(en['pubcard.ctaOwnCardHint']);
    await expect(page.getByTestId('pubcard-edit-profile')).toHaveAttribute('href', '/me/profile');
    console.log('[own-card] the owner’s card (no membership at all) → own-card state');

    // ── 1b. AFTER joining their own event — the self-join that caused it ─────
    await joinEvent(page, event.slug);
    await page.goto(path);
    await waitHydrated(page);
    await expect(
      page.getByTestId('pubcard-owncard-cta'),
      'the self-join must not turn the owner’s own card into an introduction',
    ).toBeVisible();
    expect(await presentStates(page), 'exactly one state, and it is the owner’s').toEqual(['pubcard-owncard-cta']);
    // The useful things are still on the page: the editor link, the share strip
    // and the QR the card already carries. Nothing was moved or removed.
    await expect(page.getByTestId('pubcard-share')).toBeVisible();
    await expect(page.getByTestId('pubcard-qr')).toBeVisible();
    await expect(page.getByTestId('pubcard-qr-download')).toBeVisible();
    await expect(page.getByTestId('pubcard-vcard')).toBeVisible();
    console.log('[own-card] the owner’s card while a member of their own event → own-card state, no introduction');

    // ── 2. The SERVER guard, forced past the UI ──────────────────────────────
    // The UI no longer offers this request, so it has to be made by hand for the
    // guard to be observable at all. The owner's own profile id is read from the
    // directory a NEIGHBOUR sees (a directory never lists its own reader).
    const ctxN = await browser.newContext({ viewport: MOBILE });
    contexts.push(ctxN);
    const neighbour = await ctxN.newPage();
    await loginViaOtp(neighbour, NEIGHBOUR_EMAIL);
    await seedProfile(neighbour, NEIGHBOUR_NAME);
    await joinEvent(neighbour, event.slug);
    const directory = await neighbour.request.get(`/api/events/${event.slug}/directory?mode=all`);
    expect(directory.status(), await directory.text()).toBe(200);
    const members = ((await directory.json()) as { members: { profile_id: string; display_name: string }[] }).members;
    const ownerInDirectory = members.find((m) => m.display_name === OWNER_NAME);
    expect(ownerInDirectory, `the owner must be visible to the neighbour: ${JSON.stringify(members)}`).toBeTruthy();

    const forced = await page.request.post('/api/introductions', {
      data: { target_profile_id: ownerInDirectory!.profile_id, event_id: event.id },
    });
    const forcedBody = (await forced.json()) as { code?: string };
    console.log(`[own-card] forced self-request → ${forced.status()} ${JSON.stringify(forcedBody)}`);
    expect(forced.status(), 'the UI is not the only defence').toBe(400);
    expect(forcedBody.code).toBe('self_intro');

    // ── 3. A member who shares the event: the introduction, unchanged ────────
    await neighbour.goto(path);
    await waitHydrated(neighbour);
    await expect(neighbour.getByTestId('pubcard-intro-cta'), 'a shared event still offers an introduction').toBeVisible();
    expect(await presentStates(neighbour)).toEqual(['pubcard-intro-cta']);
    console.log('[own-card] neighbour (shares the event) → introduction, unchanged');

    // ── 4. Signed in, no shared event: still the honest state ────────────────
    const ctxS = await browser.newContext({ viewport: MOBILE });
    contexts.push(ctxS);
    const stranger = await ctxS.newPage();
    await loginViaOtp(stranger, STRANGER_EMAIL);
    await seedProfile(stranger, 'Own Card Stranger');
    await stranger.goto(path);
    await waitHydrated(stranger);
    await expect(stranger.getByTestId('pubcard-noconnection-cta')).toBeVisible();
    await expect(stranger.getByTestId('pubcard-noconnection-cta')).toContainText(en['pubcard.ctaNothingYet']);
    expect(await presentStates(stranger)).toEqual(['pubcard-noconnection-cta']);
    console.log('[own-card] signed-in stranger (no shared event) → no-connection state, unchanged');

    // ── 5. Anonymous: sign in, and never the owner's state ───────────────────
    const ctxA = await browser.newContext({ viewport: MOBILE });
    contexts.push(ctxA);
    const anon = await ctxA.newPage();
    await anon.goto(path);
    await waitHydrated(anon);
    await expect(anon.getByTestId('pubcard-signin-cta')).toBeVisible();
    expect(await presentStates(anon)).toEqual(['pubcard-signin-cta']);
    console.log('[own-card] anonymous visitor → sign-in CTA, unchanged');
  } finally {
    for (const context of contexts) await context.close();
  }
});

test('own card: the state says the same thing in all three languages', async ({ page }) => {
  test.setTimeout(180_000);
  {
    await page.setViewportSize(MOBILE);
    await loginViaOtp(page, 'own-card-locale@example.org');
    await seedProfile(page, 'Own Card Locale');
    const path = await cardPath(page);

    for (const locale of ['en', 'ru', 'es'] as const) {
      await page.goto(`${path}?lang=${locale}`);
      await waitHydrated(page);
      const own = page.getByTestId('pubcard-owncard-cta');
      await expect(own, `the own-card state must render in ${locale}`).toBeVisible();
      // The dictionary is the oracle: identical English in all three rows would
      // mean the locale never applied.
      await expect(own.getByTestId('pubcard-owncard-text')).toHaveText(copy(locale, 'pubcard.ctaOwnCard'));
      await expect(own).toContainText(copy(locale, 'pubcard.ctaOwnCardHint'));
      await expect(page.getByTestId('pubcard-edit-profile')).toHaveText(copy(locale, 'pubcard.ctaEditProfile'));
      await expect(page.getByTestId('pubcard-intro-cta')).toHaveCount(0);
      console.log(`[own-card] ${locale}: "${copy(locale, 'pubcard.ctaOwnCard')}"`);
    }
  }
});

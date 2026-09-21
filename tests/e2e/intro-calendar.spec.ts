import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { en } from '../../src/i18n/en';

/**
 * The introduction card's calendar control — the ability to put an AGREED
 * meeting in the owner's own Google Calendar, on top of an endpoint that already
 * existed (`POST /api/me/calendar/google`).
 *
 * WHAT THIS SPEC IS HERE TO PROVE, AND WHY IT CANNOT PROVE THE REST:
 *
 *   1. **THE CONTROL BELONGS TO AN AGREEMENT.** It is absent while the request
 *      is pending and appears when both sides have accepted — the counterpart's
 *      public card slug, which the endpoint resolves, is only sent to the client
 *      in that state (src/app/me/introductions/page.tsx);
 *   2. **NOTHING IS SENT BEFORE THE USER ACTS.** The spec counts every request to
 *      `/api/me/calendar/google` across the whole flow and asserts there are
 *      NONE: not on render, not on navigation, not on the accept that creates the
 *      agreement;
 *   3. **THE STATE IS HONEST.** On this server a Google OAuth client IS
 *      configured (playwright.config.ts) and this account has never connected
 *      one, so the card must say exactly that and offer the one place that fixes
 *      it — and it must offer NO form, because a press could only fail.
 *
 * The states a browser cannot reach here are asserted in
 * tests/unit/intro-calendar-states.test.ts, by rendering the same component:
 * `ready` needs a real Google grant (the e2e server has fake credentials and no
 * Google), and `not_configured` needs a server with the two variables DELETED,
 * which this one shared `next dev` cannot be. The success path — the exact body
 * this control builds, through the real route handler with Google mocked at the
 * transport — is tests/integration/google-oauth.test.ts.
 */

const A_EMAIL = 'intro-calendar-a@example.org';
const B_EMAIL = 'intro-calendar-b@example.org';
const EVENT_SLUG = 'e2e-intro-calendar';
const MOBILE = { width: 390, height: 844 };

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

async function axeViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.map((v) => `${v.id} [${v.impact}] ${v.help} (${v.nodes.length} node(s))`);
}

test('intro calendar: the agreed meeting gets an honest control, and nothing is sent before the user acts', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);

  // ── Account A: signs in, gets a profile and an event, and joins it ─────────
  await page.setViewportSize(MOBILE);
  await loginViaOtp(page, A_EMAIL);
  const profileA = await page.request.post('/api/me/profile', { data: { display_name: 'Anna Calendarpone' } });
  if (profileA.status() !== 200) {
    // The fixture is re-runnable: an account that already has a profile is
    // refused by design, and that exact refusal is the accepted outcome here.
    expect((await profileA.json()).code).toBe('revision_required');
  }
  const created = await page.request.post('/api/organizer/events', {
    data: { name: 'E2E Intro Calendar Mixer', slug: EVENT_SLUG, mode: 'offline', access_mode: 'public', timezone: 'Europe/Madrid' },
  });
  expect([201, 409], `event create: ${created.status()}`).toContain(created.status());

  await page.goto(`/e/${EVENT_SLUG}`);
  await waitHydrated(page);
  await page.getByTestId('join-button').click();
  await expect(page.getByTestId('member-panel')).toBeVisible({ timeout: 30_000 });
  await waitHydrated(page);
  // A must be visible in the directory, or B cannot see the person to introduce.
  // The write is confirmed against its own response, not the optimistic checkbox.
  const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/me/memberships/'));
  await page.getByTestId('event-directory-toggle').check();
  expect((await patched).status()).toBe(200);

  // ── Account B: profile, joins the same event, and proposes the intro ───────
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageB = await ctxB.newPage();
  let calendarPosts = 0;
  const countCalendarPosts = (candidate: Page) => {
    candidate.on('request', (request) => {
      if (request.url().includes('/api/me/calendar/google') && request.method() === 'POST') calendarPosts += 1;
    });
  };
  countCalendarPosts(page);
  countCalendarPosts(pageB);

  try {
    await loginViaOtp(pageB, B_EMAIL);
    const profileB = await pageB.request.post('/api/me/profile', { data: { display_name: 'Boris Calendarpone' } });
    if (profileB.status() !== 200) expect((await profileB.json()).code).toBe('revision_required');
    const joined = await pageB.request.post(`/api/events/${EVENT_SLUG}/join`, { data: {} });
    expect([200, 409], `join: ${joined.status()}`).toContain(joined.status());

    const directory = await pageB.request.get(`/api/events/${EVENT_SLUG}/directory?mode=all`);
    expect(directory.status(), await directory.text()).toBe(200);
    const members = ((await directory.json()) as { members: { profile_id: string; display_name: string }[] }).members;
    const anna = members.find((m) => m.display_name === 'Anna Calendarpone');
    expect(anna, `A must be in the directory: ${JSON.stringify(members)}`).toBeTruthy();

    const proposed = await pageB.request.post('/api/introductions', {
      data: { target_profile_id: anna!.profile_id },
    });
    expect([200, 201], `intro: ${proposed.status()}`).toContain(proposed.status());

    // ── The card BEFORE the agreement: the initiator is waiting, and there is
    //    no calendar control, because there is no agreed meeting yet ─────────
    await pageB.goto('/me/introductions');
    await waitHydrated(pageB);
    await expect(pageB.locator('[data-testid^="intro-state"]').first()).toHaveText(/Waiting for response/);
    await expect(pageB.locator('[data-testid^="intro-calendar-"]')).toHaveCount(0);

    // ── A accepts: the introduction becomes mutual ─────────────────────────
    await page.goto('/me/introductions');
    await waitHydrated(page);
    await expect(page.locator('[data-testid^="intro-calendar-"]'), 'no agreement, no meeting control').toHaveCount(0);
    const accepted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/respond'));
    await page.getByRole('button', { name: en['intros.accept'] }).first().click();
    expect((await accepted).status()).toBe(200);
    await page.reload();
    await waitHydrated(page);

    // ── The card AFTER the agreement: the control is there, in the honest
    //    state for this account (configured instance, nothing connected) ─────
    const block = page.locator('[data-testid^="intro-calendar-"]').first();
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(block).toHaveAttribute('data-calendar-state', 'not_connected');
    await expect(block).toContainText(en['intros.calendar.title']);
    await expect(page.locator('[data-testid^="intro-calendar-connection-"]').first()).toHaveText(
      en['intros.calendar.notConnected'],
    );
    // The way out is a link to the one page that can fix it…
    const connect = page.locator('[data-testid^="intro-calendar-connect-"]').first();
    await expect(connect).toHaveAttribute('href', '/me/connections');
    const connectBox = await connect.boundingBox();
    expect(connectBox, 'the link must have a box').not.toBeNull();
    expect(connectBox!.height, 'the link is a tap target').toBeGreaterThanOrEqual(44);
    // …and NOTHING TO PRESS THAT COULD ONLY FAIL: no date field, no submit.
    await expect(page.locator('[data-testid^="intro-calendar-start-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="intro-calendar-submit-"]')).toHaveCount(0);

    // ── The gate on this page ────────────────────────────────────────────────
    expect(await axeViolations(page), 'axe on the introductions cabinet').toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'no horizontal overflow at 390px').toBeLessThanOrEqual(1);

    // ── THE PRINCIPLE THE WHOLE CONTROL RESTS ON ─────────────────────────────
    // Rendering, navigating, accepting and revealing all happened above. None of
    // them may have sent a request: a calendar entry is something the user asked
    // for, and this number is what says so.
    expect(calendarPosts, 'nothing may be sent before the user acts').toBe(0);

    console.log(
      `[intro-calendar] mutual card: state=not_connected connect=${connectBox!.height}px `
      + `overflow=${overflow}px calendar_posts=${calendarPosts}`,
    );
  } finally {
    await ctxB.close();
  }
});

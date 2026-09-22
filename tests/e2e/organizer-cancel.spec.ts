import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { en } from '../../src/i18n/en';

/**
 * THE STOP BUTTON, DRIVEN THE WAY AN ORGANIZER WOULD USE IT.
 *
 * `cancelled` was declared in the state union, the DB check, the UI labels and the
 * immutability guard, and nothing could reach it: an organizer who approved a
 * campaign by mistake had no way to stop the sends it was about to queue. This
 * spec walks the whole path in a browser — approve, send, then STOP — and asserts
 * what the organizer is told, because the sentence is half the feature: a stop
 * that reports "cancelled" without saying what happened to the queue is the same
 * defect as an affordance that can only fail, just quieter.
 *
 * WHAT IS DRIVEN THROUGH THE UI AND WHAT IS NOT. The campaign's whole lifecycle is
 * driven through the organizer console (create, approve, send, cancel) because that
 * lifecycle is the thing under test. The FIXTURES around it — the profile, the
 * event, the member's membership, visibility, and the member's event-scoped
 * marketing consent — go through the same public routes the event page's own
 * controls use (`/api/events/:id/join`, `PATCH /api/me/memberships/:id`,
 * `POST /api/consents`), because a second browser walking four more forms around
 * the campaign would hide the campaign.
 *
 * WHY THE MEMBER MATTERS AT ALL. A campaign only becomes `running` when something
 * is queued, and a recipient exists only inside this event's organizer_marketing
 * consent scope with directory visibility on. Without one the send queues nobody,
 * the campaign completes on the spot (that is a different, tested behaviour), and
 * there would be no `running` campaign to stop — so the fixture is the difference
 * between testing the button and testing nothing.
 *
 * THE NEGATIVES MATTER AS MUCH AS THE POSITIVES: after the cancel, the card must
 * offer no Send, no Approve and no Edit — a cancelled campaign is immutable — and
 * the queue must actually be suppressed in the database-backed stats the console
 * reads, not merely relabelled.
 */

const ORG_EMAIL = 'cancel-org@example.org';
const MEMBER_EMAIL = 'cancel-member@example.org';
const EVENT_SLUG = 'e2e-cancel-mixer';
const EVENT_NAME = 'E2E Cancel Mixer';

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

async function seedProfile(page: Page, displayName: string): Promise<void> {
  const res = await page.request.post('/api/me/profile', {
    data: { display_name: displayName, languages: ['en'] },
  });
  expect(res.status(), `profile for ${displayName}: ${await res.text()}`).toBe(200);
}

test('cancel: an organizer stops a running campaign and is told what happened to the queue', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const contexts: BrowserContext[] = [];
  try {
    // ── The organizer: profile and event ─────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await loginViaOtp(page, ORG_EMAIL);
    await seedProfile(page, 'Cancel Organizer');
    const created = await page.request.post('/api/organizer/events', {
      data: { name: EVENT_NAME, slug: EVENT_SLUG, mode: 'offline', access_mode: 'public', timezone: 'UTC' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const event = ((await created.json()) as { event: { id: string; slug: string } }).event;

    // ── The member: joins, is visible, and consents to organizer marketing ───
    // All three are the SAME writes the event page's own controls make: the join
    // button, the directory toggle and the marketing consent toggle, driven here
    // through their routes instead of through four more forms. An
    // organizer_marketing audience needs BOTH the event-scoped consent and
    // directory visibility — without either, the send queues nobody and there is
    // no running campaign to stop.
    const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
    contexts.push(ctxM);
    const member = await ctxM.newPage();
    await loginViaOtp(member, MEMBER_EMAIL);
    await seedProfile(member, 'Cancel Member');
    const joined = await member.request.post(`/api/events/${event.id}/join`, { data: {} });
    expect(joined.status(), await joined.text()).toBe(200);

    // The directory toggle is the console's own control (membership-editor.tsx):
    // click it and wait for the PATCH it makes.
    await member.goto('/me/events');
    await waitHydrated(member);
    const toggled = member.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes('/api/me/memberships/'),
    );
    await member.getByTestId(`dir-toggle-${event.id}`).check();
    expect((await toggled).status()).toBe(200);

    const consented = await member.request.post('/api/consents', {
      data: {
        action: 'grant',
        purpose: 'organizer_marketing',
        scope_type: 'event',
        scope_id: event.id,
        policy_version: '2026-09-p0',
      },
    });
    expect(consented.status(), await consented.text()).toBe(200);
    console.log('[cancel] fixture ready: one event, one visible consenting member');

    // ── The campaign: create → approve → send (through the console) ──────────
    await page.goto(`/organizer/events/${event.id}/campaigns`);
    await waitHydrated(page);
    await page.locator('#camp-purpose').selectOption('organizer_marketing');
    await page.getByTestId('camp-body').fill('This one is going out by mistake.');
    await page.getByTestId('create-campaign').getByRole('button').first().click();
    await expect(page.getByTestId('create-campaign').getByTestId('toast-success')).toBeVisible();
    const card = page.locator('[data-testid^="campaign-"]').first();
    await expect(card).toBeVisible();
    const campaignId = (await card.getAttribute('data-testid'))!.replace('campaign-', '');

    // Nothing to stop yet: the button is not offered in draft.
    await expect(
      page.getByTestId(`campaign-cancel-${campaignId}`),
      'a draft has nothing queued, so the stop button must not be offered',
    ).toHaveCount(0);

    const approved = page.waitForResponse((r) => r.url().endsWith('/approve') && r.request().method() === 'POST');
    await page.getByTestId(`campaign-approve-${campaignId}`).click();
    expect((await approved).status()).toBe(200);
    await expect(page.getByTestId(`campaign-send-${campaignId}`)).toBeVisible();
    await expect(
      page.getByTestId(`campaign-cancel-${campaignId}`),
      'approved is still nothing queued — the honest tools there are edit and re-approve',
    ).toHaveCount(0);

    await page.getByTestId(`campaign-send-${campaignId}`).click();
    const sent = page.waitForResponse((r) => r.url().endsWith('/send') && r.request().method() === 'POST');
    await page.getByTestId('confirm-send').click();
    const sentRes = await sent;
    expect(sentRes.status(), await sentRes.text()).toBe(202);
    const queued = ((await sentRes.json()) as { queued: number }).queued;
    expect(queued, 'the fixture must actually queue a message, or there is nothing to stop').toBe(1);
    await page.reload();
    await waitHydrated(page);
    await expect(page.getByTestId(`campaign-state-${campaignId}`)).toHaveText(en['camp.state.running']);
    console.log(`[cancel] campaign ${campaignId} running with ${queued} queued`);

    // ── THE STOP BUTTON ──────────────────────────────────────────────────────
    const stop = page.getByTestId(`campaign-cancel-${campaignId}`);
    await expect(stop, 'a running campaign must offer the stop button').toBeVisible();
    await stop.click();
    // The confirmation states what a cancel cannot do before what it does.
    await expect(page.getByText(en['camp.cancelConfirmText'])).toBeVisible();

    const cancelled = page.waitForResponse((r) => r.url().endsWith('/cancel') && r.request().method() === 'POST');
    await page.getByTestId('confirm-cancel').click();
    const cancelledRes = await cancelled;
    expect(cancelledRes.status(), await cancelledRes.text()).toBe(200);
    const body = (await cancelledRes.json()) as { suppressed: number; sent: number; already_cancelled: boolean };
    expect(body.suppressed).toBe(1);
    expect(body.sent).toBe(0);
    expect(body.already_cancelled).toBe(false);

    // What the organizer is TOLD: both numbers, by name.
    const note = page.locator('[data-testid^="campaign-"]').first().getByRole('status');
    await expect(note).toBeVisible({ timeout: 15_000 });
    await expect(note).toContainText(en['camp.cancelResult'].replace('{suppressed}', '1'));
    await expect(note).toContainText(en['camp.cancelResultSent'].replace('{sent}', '0'));
    console.log(`[cancel] note: "${(await note.innerText()).trim()}"`);

    // The state changed, and the console cannot pretend otherwise.
    await page.reload();
    await waitHydrated(page);
    await expect(page.getByTestId(`campaign-state-${campaignId}`)).toHaveText(en['camp.state.cancelled']);
    await expect(page.getByTestId(`campaign-cancel-${campaignId}`), 'already stopped: no second stop button').toHaveCount(0);
    await expect(page.getByTestId(`campaign-send-${campaignId}`), 'a cancelled campaign cannot be sent').toHaveCount(0);
    await expect(page.getByTestId(`campaign-approve-${campaignId}`)).toHaveCount(0);
    await expect(page.getByTestId(`campaign-edit-${campaignId}`), 'a cancelled campaign is immutable').toHaveCount(0);

    // The queue really was suppressed, not merely relabelled: the console's own
    // stats read the job rows.
    await page.getByTestId(`campaign-stats-${campaignId}`).click();
    const stats = page.getByTestId(`stats-${campaignId}`);
    await expect(stats).toBeVisible();
    await expect(stats).toContainText(en['camp.stats.suppressed']);
    const counters = await stats.evaluate((el) => el.textContent ?? '');
    expect(counters, 'one suppressed, none pending').toMatch(/1[^\d]*Suppressed/);
    expect(counters).not.toMatch(/1[^\d]*Pending/);
    console.log('[cancel] stats after the stop match the queue: 1 suppressed, 0 pending');
  } finally {
    for (const context of contexts) await context.close();
  }
});

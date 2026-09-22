import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * WHICH LIST THE DIRECTORY OPENS ON, for the three kinds of viewer.
 *
 * The default mode is `intent` — "they seek what I offer" — because that is the
 * view the offer/need axes exist to produce. The one exception is a viewer whose
 * offer axis is EMPTY: the API builds the intent filter from
 * `complementOf(viewer.offer_intents)` and returns `members: []` when there is
 * nothing to look for (its own words: "honest empty result, not a full directory
 * dump"), so opening on `intent` there would be an empty screen caused by
 * arithmetic, not by the event. Those two viewers are the first two tests below,
 * and they must reach DIFFERENT defaults while looking at the SAME event — which
 * is why the event, the candidate and the member list are shared between them and
 * only the viewer's own offers differ.
 *
 * The third kind is the anonymous visitor: the directory is members-only
 * (`requireAccountId`), and the honest assertion is that they never see the list
 * at all.
 *
 * A narrowed list must also always be widen-able from the page itself, which is
 * what the `dir-show-everyone` control is: it is asserted to be PRESENT while the
 * list is narrowed, ABSENT when it is not, and to actually widen the list when
 * clicked — including from the empty state, which is the one place a reader is
 * most likely to be stuck.
 */

const EVENT_SLUG = 'e2e-directory-mode';
const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL || 'postgres://localhost:5432/welcome_e2e';
const sql = postgres(E2E_DATABASE_URL, { max: 1, idle_timeout: 5 });

test.afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** Offers `mentoring`, whose catalogue complement is `seeking-mentor`. */
const WITH_OFFERS = {
  email: 'dir-mode-with@example.org',
  name: 'Dir Mode With Offers',
  body: { offer_intents: ['mentoring'], interests: ['ai-ml'] },
};
/** Offers NOTHING: no `intent` list can exist for this viewer, however full the event is. */
const WITHOUT_OFFERS = {
  email: 'dir-mode-without@example.org',
  name: 'Dir Mode Without Offers',
  body: { interests: ['ai-ml'] },
};
/** Seek what the first viewer offers, so its `intent` list is genuinely non-empty. */
const CANDIDATE = { name: 'Dir Mode Candidate', body: { need_intents: ['seeking-mentor'] } };

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

/** Joins through the UI and opts into the directory — the real member flow. */
async function joinAndOptIn(page: Page, slug: string): Promise<void> {
  await page.goto(`/e/${slug}`);
  await waitHydrated(page);
  await page.getByTestId('join-button').click();
  await expect(page.getByTestId('member-panel')).toBeVisible();
  await waitHydrated(page);
  await page.getByTestId('event-directory-toggle').check();
  await expect(page.getByTestId('event-directory-toggle')).toBeChecked();
}

test('directory mode: a viewer with offers opens on "they seek what I offer", and can widen it', async ({ page }) => {
  test.setTimeout(180_000);
  await loginViaOtp(page, WITH_OFFERS.email);
  const profile = await page.request.post('/api/me/profile', {
    data: { display_name: WITH_OFFERS.name, languages: ['en'], ...WITH_OFFERS.body },
  });
  expect(profile.status(), await profile.text()).toBe(200);

  const created = await page.request.post('/api/organizer/events', {
    data: { name: 'E2E Directory Mode', slug: EVENT_SLUG, mode: 'offline', access_mode: 'public', timezone: 'UTC' },
  });
  expect(created.status(), await created.text()).toBe(201);
  const eventId = ((await created.json()) as { event: { id: string } }).event.id;
  await joinAndOptIn(page, EVENT_SLUG);

  // A candidate who needs exactly what the viewer offers, seeded straight into
  // the e2e database (no second OTP login for a fixture).
  const accounts = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'e2e:dirmode:candidate'}) RETURNING id
  `;
  const slug = `${'e2e-dirmode-candidate'}`.padEnd(24, 'x');
  const profiles = await sql<{ id: string }[]>`
    INSERT INTO profiles (account_id, public_slug, display_name, languages, need_intents, offer_intents, interests)
    VALUES (${accounts[0]!.id}, ${slug}, ${CANDIDATE.name}, ARRAY['en'],
            ${CANDIDATE.body.need_intents}, ARRAY[]::text[], ARRAY['ai-ml'])
    RETURNING id
  `;
  await sql`
    INSERT INTO event_memberships (event_id, profile_id, state, directory_visible, matching_enabled)
    VALUES (${eventId}, ${profiles[0]!.id}, 'active', true, true)
  `;

  // NO ?mode= IN THE URL: the default is what is under test.
  await page.goto(`/me/events/${EVENT_SLUG}/directory`);
  await waitHydrated(page);
  await expect(page.getByTestId('member-list')).toBeVisible({ timeout: 30_000 });

  await expect(page.getByTestId('dir-mode-intent'), 'a viewer with offers must open on the intent view').toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('dir-mode-all')).toHaveAttribute('aria-selected', 'false');
  // ...and the intent list is genuinely non-empty here, so this is the product's
  // differentiated view doing its job rather than a coincidence of defaults.
  await expect(page.getByTestId('member-list')).toContainText(CANDIDATE.name);
  await expect(page.getByTestId('directory-empty')).toHaveCount(0);

  // The way out of a narrowed list, from the page's own controls.
  const widen = page.getByTestId('dir-show-everyone');
  await expect(widen, 'a narrowed list must offer the way to widen it').toBeVisible();
  await widen.click();
  await expect(page.getByTestId('dir-mode-all')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('member-list')).toContainText(CANDIDATE.name);
  await expect(widen, 'an un-narrowed list has nothing to widen').toHaveCount(0);
});

test('directory mode: a viewer with no offers opens on everyone, not on an empty-by-arithmetic list', async ({ page }) => {
  test.setTimeout(180_000);
  await loginViaOtp(page, WITHOUT_OFFERS.email);
  const profile = await page.request.post('/api/me/profile', {
    data: { display_name: WITHOUT_OFFERS.name, languages: ['en'], ...WITHOUT_OFFERS.body },
  });
  expect(profile.status(), await profile.text()).toBe(200);
  await joinAndOptIn(page, EVENT_SLUG);

  // The SAME event as the test above, so the only thing that differs is the
  // viewer's own offer axis — which is exactly the variable under test.
  await page.goto(`/me/events/${EVENT_SLUG}/directory`);
  await waitHydrated(page);
  await expect(page.getByTestId('member-list')).toBeVisible({ timeout: 30_000 });

  await expect(
    page.getByTestId('dir-mode-all'),
    'with nothing to look for, the intent view is empty by construction — so it is not the default',
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('dir-mode-intent')).toHaveAttribute('aria-selected', 'false');
  // The point of the fallback: the list the viewer lands on is NOT empty.
  await expect(page.getByTestId('member-list')).toContainText(CANDIDATE.name);
  await expect(page.getByTestId('directory-empty')).toHaveCount(0);
  await expect(page.getByTestId('dir-show-everyone'), 'nothing is narrowed, so nothing to widen').toHaveCount(0);

  // The narrowed view is still reachable — and it is honest about being empty,
  // with the way back rendered next to the count.
  await page.getByTestId('dir-mode-intent').click();
  await expect(page.getByTestId('dir-mode-intent')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('directory-empty')).toBeVisible();
  await expect(page.getByTestId('dir-result-count')).toContainText('0');
  const widen = page.getByTestId('dir-show-everyone');
  await expect(widen, 'the empty state must offer the way out').toBeVisible();
  await widen.click();
  await expect(page.getByTestId('dir-mode-all')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('member-list')).toContainText(CANDIDATE.name);
});

test('directory mode: an anonymous visitor never sees the list', async ({ page }) => {
  test.setTimeout(120_000);
  const response = await page.goto(`/me/events/${EVENT_SLUG}/directory`);
  // The directory is members-only. `requireAccountId` answers with a redirect, so
  // the assertion is about the CHAIN rather than about one status code: the
  // browser was sent away from the directory (the request the document came from
  // was itself redirected) and landed on the sign-in form, and nothing from the
  // directory body was ever rendered.
  expect(
    response?.request().redirectedFrom(),
    'the directory request must be redirected, not served',
  ).not.toBeNull();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await expect(page.getByTestId('login-email')).toBeVisible();
  await expect(page.getByTestId('dir-mode-all')).toHaveCount(0);
  const html = await page.content();
  expect(html, 'no member of the directory may be named to an anonymous visitor').not.toContain(CANDIDATE.name);
  expect(html).not.toContain(WITH_OFFERS.name);
  console.log(`[directory] anonymous visitor redirected to ${page.url()}`);
});

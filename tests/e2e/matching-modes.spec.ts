import { test, expect, type Page } from '@playwright/test';
import postgres from 'postgres';

/**
 * Matching v4 e2e (design §B3/§B4): the mode switcher changes the strip, and
 * every recommendation explains itself in the two lines «Useful» / «Growth».
 *
 * Only the VIEWER is a real browser account — the three candidates are seeded
 * straight into the e2e database. That is deliberate: the spec asserts what a
 * viewer SEES, and each extra OTP login spends the shared per-IP bucket
 * (src/lib/http.ts: 10 sign-in codes per minute) that the rest of the suite
 * needs. The viewer still signs in, joins and opts in through the UI.
 */

const EVENT_SLUG = 'e2e-matching-v4';

const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL || 'postgres://localhost:5432/welcome_e2e';
const sql = postgres(E2E_DATABASE_URL, { max: 1, idle_timeout: 5 });

test.afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const VIEWER = {
  email: 'v4-viewer@example.org',
  name: 'V4 Viewer',
  body: {
    need_intents: ['seeking-mentor'],
    offer_intents: ['mentoring'],
    interests: ['ai-ml', 'startups'],
    industry: 'ai-saas',
    job_function: 'founder-ceo',
    goals: ['learn-skill'],
  },
};
const TEACHER = {
  email: 'v4-teacher@example.org',
  name: 'V4 Teacher',
  body: { offer_intents: ['mentoring'], interests: ['ai-ml'] },
};
const PEER = {
  email: 'v4-peer@example.org',
  name: 'V4 Peer',
  body: { interests: ['ai-ml', 'startups'], industry: 'ai-saas', job_function: 'founder-ceo' },
};
const OUTSIDER = {
  email: 'v4-outsider@example.org',
  name: 'V4 Outside',
  body: { interests: ['ai-ml'], industry: 'health-beauty', job_function: 'design' },
};

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

let seedSeq = 0;

/** Seeds a candidate profile + an opted-in membership, without a login. */
async function seedCandidate(eventId: string, user: { name: string; body: Record<string, unknown> }): Promise<void> {
  seedSeq += 1;
  // profiles.public_slug has a >= 22 character CHECK (migration 001).
  const slug = `e2e-v4-${Date.now().toString(36)}-${seedSeq}`.padEnd(24, 'x');
  const accounts = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject) VALUES (${'e2e:v4:' + slug}) RETURNING id
  `;
  const profiles = await sql<{ id: string }[]>`
    INSERT INTO profiles (account_id, public_slug, display_name, languages,
                          need_intents, offer_intents, interests, industry, job_function)
    VALUES (${accounts[0]!.id}, ${slug}, ${user.name}, ARRAY['en'],
            ${(user.body['need_intents'] as string[]) ?? []},
            ${(user.body['offer_intents'] as string[]) ?? []},
            ${(user.body['interests'] as string[]) ?? []},
            ${(user.body['industry'] as string | null) ?? null},
            ${(user.body['job_function'] as string | null) ?? null})
    RETURNING id
  `;
  await sql`
    INSERT INTO event_memberships (event_id, profile_id, state, directory_visible, matching_enabled)
    VALUES (${eventId}, ${profiles[0]!.id}, 'active', true, true)
  `;
}

/** Joins through the UI and opts into the directory (the real member flow). */
async function joinAndOptIn(page: Page, slug: string): Promise<void> {
  await page.goto(`/e/${slug}`);
  await waitHydrated(page);
  await page.getByTestId('join-button').click();
  await expect(page.getByTestId('member-panel')).toBeVisible();
  await waitHydrated(page);
  await page.getByTestId('event-directory-toggle').check();
  await expect(page.getByTestId('event-directory-toggle')).toBeChecked();
}

test('matching v4: the four modes show different people, each with two lines of reasons', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const viewer = await context.newPage();
  await loginViaOtp(viewer, VIEWER.email);
  const profileRes = await viewer.request.post('/api/me/profile', {
    data: { display_name: VIEWER.name, languages: ['en'], ...VIEWER.body },
  });
  expect(profileRes.status()).toBe(200);

  const eventRes = await viewer.request.post('/api/organizer/events', {
    data: { name: 'E2E Matching v4', mode: 'offline', access_mode: 'public', timezone: 'UTC', slug: EVENT_SLUG },
  });
  expect(eventRes.status()).toBe(201);
  const eventId = ((await eventRes.json()) as { event: { id: string } }).event.id;

  await joinAndOptIn(viewer, EVENT_SLUG);
  await seedCandidate(eventId, TEACHER);
  await seedCandidate(eventId, PEER);
  await seedCandidate(eventId, OUTSIDER);

  try {
    const page = viewer;
    await page.goto(`/me/events/${eventId}/directory`);
    await waitHydrated(page);

    const strip = page.locator('section[aria-labelledby="recs-heading"]');
    await expect(strip).toBeVisible();

    // ── default mode: `useful` — the person who closes my request ────────────
    await expect(page.getByTestId('rec-mode-useful')).toHaveAttribute('aria-selected', 'true');
    await expect(strip.getByText(TEACHER.name)).toBeVisible();
    // A peer with no complementarity is not "useful" — that is what modes are for.
    await expect(strip.getByText(PEER.name)).toHaveCount(0);

    // The two lines, rendered from codes into the viewer's language.
    await expect(strip.getByText('Useful', { exact: true }).first()).toBeVisible();
    await expect(strip.getByText('Growth', { exact: true }).first()).toBeVisible();
    await expect(strip.getByText(/Covers what you are looking for:/)).toBeVisible();
    await expect(strip.getByText(/You can learn from them:/)).toBeVisible();

    // ── "Like me": peer networking ───────────────────────────────────────────
    await page.getByTestId('rec-mode-similar').click();
    await expect(page.getByTestId('rec-mode-similar')).toHaveAttribute('aria-selected', 'true');
    await expect(strip.getByText(PEER.name)).toBeVisible();

    // ── "Wider circle": a different context that still shares a topic ────────
    await page.getByTestId('rec-mode-explore').click();
    await expect(page.getByTestId('rec-mode-explore')).toHaveAttribute('aria-selected', 'true');
    await expect(strip.getByText(OUTSIDER.name)).toBeVisible();

    // ── "Grow": someone to learn from ────────────────────────────────────────
    await page.getByTestId('rec-mode-grow').click();
    await expect(strip.getByText(TEACHER.name)).toBeVisible();

    // Switching back restores the default answer.
    await page.getByTestId('rec-mode-useful').click();
    await expect(strip.getByText(PEER.name)).toHaveCount(0);
    await expect(strip.getByText(TEACHER.name)).toBeVisible();
  } finally {
    await context.close();
  }
});

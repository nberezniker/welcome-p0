// Evidence screenshot capture (Phase 4 acceptance).
//
// A RUN OF THIS SCRIPT MUST LEAVE THE TRACKED EVIDENCE BYTE-IDENTICAL unless the
// product actually changed. Otherwise every capture produces a diff, and the one
// line in it that matters is buried under the ones that do not — which is how
// this folder stopped being reviewable. Two sources of drift used to make that
// impossible, and both were measured on consecutive runs rather than guessed at:
//
//   1. THE PUBLIC SLUG IS RANDOM. `generatePublicSlug()` mints 16 random bytes per
//      profile (src/lib/crypto.ts), and `/me` renders the card's public address AS
//      TEXT next to a QR that ENCODES it — so `me-dashboard.png` (address + code)
//      and `profile-editor.png` (the "Public address: /p/<slug>" line) came out
//      different on every run. The scenario now PINS each captured profile's slug
//      to a fixed value once the profile exists. The product is untouched — a real
//      profile's slug is still random — only this capture says "use this one".
//
//   2. THE SAVED STATE ARRIVES ASYNCHRONOUSLY. The profile editor's save handler
//      calls `router.refresh()`, and the address line is rendered from the
//      SERVER's next render. A screenshot taken as soon as the success toast
//      appeared therefore caught the page WITH that line on one run and WITHOUT it
//      on the next — same code, two different pictures. `settle()` now waits for
//      hydration, for the navigation to have landed and for every image to have
//      decoded before any shot is taken, so the capture records the state the
//      scenario meant to record instead of whichever frame it happened to catch.
//
// WHAT IS DELIBERATELY NOT DONE: masking the QR, cropping the address out, or
// normalising the PNGs afterwards. Each would make the evidence stable by making
// it less true — a card whose public address is blanked out is not the card a
// visitor gets. The instability is removed at its source, not painted over.
//
// WHAT WAS WRONG WITH THE SCENARIO (fixed, and it was NOT a capture bug). The
// two profiles used to be created with the LEGACY free-text tag fields
// (`offer_tags`/`need_tags`, the `#pf-offer`/`#pf-need` inputs) holding the
// strings 'pilot-integrations' and 'saas-distribution'. Those fields are still
// rendered and still stored, but NOTHING MATCHES ON THEM ANY MORE: the event
// directory filters on the taxonomy v3 axes (`offer_intents`/`need_intents`,
// src/domain/campaigns.ts and the directory route's intent mode), which the
// scenario never set. So the viewer had no offers, the API answered with an empty
// member list, `[data-testid=member-list]` never rendered — and this script died
// there, three screenshots short of the end. The failure was pre-existing and
// reproducible on a pristine tree; the scenario was simply describing a profile
// the current product no longer considers matchable.
//
// The fix is in the scenario, not in the capture: `pickIntents()` drives the
// taxonomy pickers the editor actually has, so the two profiles now declare the
// complementary intents a real pair of attendees would (B offers
// `open-to-cofound`, A is looking for `seeking-cofounder`; the pair table is
// INTENTS in src/domain/taxonomy.ts). The legacy tags are still filled, because
// the editor still renders them and a profile created through it plausibly has
// both — they are simply no longer load-bearing. Nothing in the product changed
// to make this pass.
//
// A RESULT OF THIS THAT IS WORTH KNOWING: with the picker filled, the campaign's
// audience is no longer empty, so `organizer-campaign-stats.png` shows a real
// queued message instead of a campaign that reached nobody.
// Prerequisites: dev server running on $E2E_BASE_URL (default 127.0.0.1:3111)
// with the e2e env (see playwright.config.ts webServer.env) — e.g.:
//   DATABASE_URL=postgres://localhost:5432/welcome_e2e APP_ENV=development \
//   AUTH_DEV_EXPOSE_OTP=true HASH_PEPPER=e2e-pepper-0123456789abcdef \
//   ENCRYPTION_KEY=$(base64 of 32 bytes) APP_BASE_URL=http://127.0.0.1:3111 \
//   pnpm exec next dev -p 3111
// The script resets the welcome_e2e schema, replays a full scenario and saves
// screenshots to evidence/screenshots/.
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { mkdirSync } from 'node:fs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3111';
const databaseUrl = process.env.E2E_DATABASE_URL || 'postgres://localhost:5432/welcome_e2e';
const OUT = path.join(ROOT, 'evidence', 'screenshots');
mkdirSync(OUT, { recursive: true });

const A = {
  email: 'alice@evidence.example.org',
  name: 'Alice Nova',
  wa: '+34600111111',
  phone: '+34600222222',
  headline: 'Backend engineer',
  // Legacy free-text tags — still rendered and still stored by the editor, no
  // longer read by matching (see the note at the top of this file).
  offerTag: 'pilot-integrations',
  needTag: 'saas-distribution',
  // The taxonomy v3 axes. THESE are what the directory matches on, and they are
  // why the directory has a row to photograph at all.
  offerIntents: ['pilot-ready'],
  needIntents: ['seeking-cofounder'],
};
const B = {
  email: 'bob@evidence.example.org',
  name: 'Bob Marlow',
  wa: '+34600333333',
  headline: 'Growth advisor',
  offerTag: 'saas-distribution',
  needTag: 'pilot-integrations',
  offerIntents: ['open-to-cofound'],
  needIntents: ['seeking-pilot-users'],
};
const SLUG = 'evidence-mixer';

/**
 * The slugs the two public cards are PINNED to for the capture (see the note at
 * the top of this file). They have to satisfy `profiles.public_slug`'s CHECK
 * (22..128 characters, db/migrations/001_init.sql) and stay URL-safe, because the
 * value ends up in a path, in the vCard URL and inside a QR: 25 characters, no
 * padding, no reserved characters.
 */
const PINNED_SLUG = { alice: 'evidence-alice-0000000001', bob: 'evidence-bob-00000000001' };

async function resetDb() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await sql.unsafe('CREATE SCHEMA public');
    await sql.unsafe('GRANT ALL ON SCHEMA public TO current_user');
  } finally {
    await sql.end({ timeout: 5 });
  }
  const r = spawnSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', cwd: ROOT, env: { ...process.env, DATABASE_URL: databaseUrl } });
  if (r.status !== 0) throw new Error('migrations failed');
}

async function waitHydrated(page) {
  await page.waitForSelector('html[data-hydrated="true"]', { state: 'attached', timeout: 30_000 });
}

/**
 * Waits until the page is ready to be PHOTOGRAPHED.
 *
 * Hydration plus image decoding, because both change pixels: a QR that has not
 * decoded yet is a blank box, and a client component that has not hydrated shows
 * the server's first paint.
 */
async function settle(page) {
  await waitHydrated(page);
  await page.evaluate(() =>
    Promise.all(
      [...document.images]
        .filter((img) => !img.complete)
        .map(
          (img) =>
            new Promise((done) => {
              img.addEventListener('load', done, { once: true });
              img.addEventListener('error', done, { once: true });
            }),
        ),
    ),
  );
}

/**
 * Waits until the campaign's delivery has actually DRAINED, and returns it.
 *
 * The stats panel is a set of counters over the outbox, and the outbox is drained
 * asynchronously (src/infra/post-response-tick.ts). The old `waitForTimeout(1500)`
 * before this screenshot therefore photographed whatever fraction of the queue had
 * been processed by then — so `organizer-campaign-stats.png` differed between two
 * runs of the same code, with different numbers in the same boxes. Waiting for
 * `pending`/`leased` to reach zero is the state the number is ABOUT; after that
 * the counters only move if the product changed, which is exactly the condition
 * under which this evidence is allowed to change.
 */
/**
 * Waits for the campaign's send to have LANDED and its numbers to stop moving.
 *
 * WHY THIS EXISTS. The old code did `await page.waitForTimeout(1500)` between
 * confirming the send and photographing its report, and 1500ms was not always
 * enough on a dev server that was still compiling: one run caught the card before
 * the send was accepted (state "Approved", editable, the report button still
 * showing) and the next caught it after (state "Running", immutable, the report
 * open). Same code, two different pictures.
 *
 * TWO CONDITIONS, each doing a specific job:
 *   · `state === 'running'` — the send has been accepted. This is the first
 *     condition and not a decoration: an EMPTY queue before the send looks
 *     exactly like a DRAINED queue after it, so a counters-only wait returned
 *     instantly on the pre-send state and photographed that instead.
 *   · the counters read the same twice in a row — quiescence. The outbox is
 *     drained asynchronously (src/infra/post-response-tick.ts), so a report read
 *     mid-drain is a different picture from the same report read a moment later.
 *
 * WHAT IT DELIBERATELY DOES NOT WAIT FOR: an empty queue. Nothing in this
 * scenario drains one — the script starts no worker process and the campaign job
 * is queued, not delivered — so `pending` stays at 1 and waiting for zero would
 * deadlock (it did, and the error is what turned this from a guess into a
 * measurement). The captured report therefore shows one queued message, which is
 * the truth about this scenario rather than a number arranged for the picture.
 *
 * `running` is also the SETTLED state for THIS scenario, and that is a property
 * of the scenario rather than of the campaign machine. Nothing here drains the
 * queue — the script starts no worker and the campaign job is queued, not
 * delivered — so the job stays `pending` and the campaign stays `running` for the
 * whole capture. `running → completed` is a real transition elsewhere (src/domain/
 * campaigns.ts `completeCampaignsIfDrained`, fired off the last recipient's
 * terminal outcome); it simply is not reached from here, because from here the
 * work genuinely has not been done. The `pending: 1` in the captured report is
 * the truth about this scenario, not a number arranged for the picture.
 */
async function waitForCampaignSettled(page, campaignId) {
  const deadline = Date.now() + 30_000;
  let previousCounters = null;
  let last = null;
  while (Date.now() < deadline) {
    const res = await page.request.get(`${baseURL}/api/organizer/campaigns/${campaignId}/stats`);
    if (res.ok()) {
      const body = await res.json();
      last = { state: body?.state, counters: body?.counters };
      const quiescent = JSON.stringify(previousCounters) === JSON.stringify(body?.counters ?? null);
      if (body?.state === 'running' && quiescent) return last;
      previousCounters = body?.counters ?? null;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(
    `campaign ${campaignId} never reached a settled 'running' state: ${JSON.stringify(last)}`,
  );
}

/**
 * Takes ONE evidence screenshot, after waiting for the thing the shot is OF.
 *
 * THIS IS THE FIX FOR THE WORST OF THE THREE DRIFTS, and it was caught by
 * comparing two runs rather than by reasoning: `profile-editor.png` came out
 * 3965px tall on one run and 900px on the next, because the second run
 * photographed `src/app/me/loading.tsx` — "Opening your dashboard…" — instead of
 * the editor. `html[data-hydrated]` is already true inside that shell, and the
 * document's `load` event fires with it, so neither was a strong enough signal.
 *
 * A selector for the real content is. Every call site names the element that must
 * be on the page before the shutter opens, which is also a statement of what the
 * image is evidence FOR: an image of a loading state is not evidence of anything.
 */
async function shoot(page, file, waitFor, { fullPage = true } = {}) {
  if (waitFor) await page.waitForSelector(waitFor, { state: 'visible', timeout: 30_000 });
  await settle(page);
  await page.screenshot({ path: file, fullPage });
}

/** The slug the API generated for the signed-in account's card, read from /me. */
async function generatedSlug(page) {
  await page.goto(`${baseURL}/me`);
  await waitHydrated(page);
  const href = await page.getByTestId('public-url').getAttribute('href');
  const slug = new URL(href).pathname.split('/').filter(Boolean).pop();
  if (!slug) throw new Error(`could not read a public slug from ${href}`);
  return slug;
}

/**
 * Pins the card's public address, and leaves the browser on the profile editor.
 *
 * The address line is rendered by the SERVER from `profiles.public_slug`, so a
 * NAVIGATION after the update is what makes the captured page the pinned one; a
 * `router.refresh()` would be the client-side path that caused the run-to-run
 * difference in the first place.
 */
async function pinPublicSlug(page, sql, pinned) {
  const current = await generatedSlug(page);
  await sql`UPDATE profiles SET public_slug = ${pinned} WHERE public_slug = ${current}`;
  await page.goto(`${baseURL}/me/profile`);
  await settle(page);
  console.log(`pinned the public card to /p/${pinned}`);
}

async function loginViaOtp(page, email) {
  await page.goto(`${baseURL}/login`);
  await waitHydrated(page);
  await page.getByTestId('login-email').fill(email);
  const rp = page.waitForResponse((r) => r.url().includes('/api/auth/otp/request'));
  await page.getByTestId('login-request').click();
  const body = await (await rp).json();
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL('**/me');
}

/**
 * Selects taxonomy intents in the profile editor's picker (`pf-offers` /
 * `pf-needs`).
 *
 * The picker renders every catalogue entry as a button whose testid is
 * `<container>-<intentId>`, and selecting one appends a chip testid
 * `<container>-selected-<intentId>`. Waiting for that chip is the confirmation:
 * clicking the option is optimistic in the DOM (React re-renders `aria-pressed`),
 * so the chip's presence is what says the value actually entered the form state
 * that `pf-save` will submit. Without this wait the save could race the click and
 * store an empty axis — which is precisely the failure this scenario had.
 */
async function pickIntents(page, container, intentIds) {
  for (const intentId of intentIds) {
    const option = page.getByTestId(`${container}-${intentId}`);
    await option.scrollIntoViewIfNeeded();
    await option.click();
    await page.waitForSelector(`[data-testid="${container}-selected-${intentId}"]`, {
      state: 'attached',
      timeout: 10_000,
    });
  }
}

async function createProfile(page, person) {
  await page.goto(`${baseURL}/me/profile`);
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill(person.name);
  await page.locator('#pf-headline').fill(person.headline);
  await page.locator('#pf-offer').fill(person.offerTag);
  await page.keyboard.press('Enter');
  await page.locator('#pf-need').fill(person.needTag);
  await page.keyboard.press('Enter');
  // The axes matching reads. Filled through the picker, not by POSTing the API,
  // so the capture photographs the editor being used the way a member uses it.
  await pickIntents(page, 'pf-offers', person.offerIntents);
  await pickIntents(page, 'pf-needs', person.needIntents);
  await page.getByTestId('pf-save').click();
  await page.waitForSelector('[data-testid=toast-success]');
}

async function addContact(page, kind, value, publish) {
  await page.goto(`${baseURL}/me/contacts`);
  await waitHydrated(page);
  await page.locator(`#contact-value-${kind}`).fill(value);
  if (publish) await page.locator(`#contact-public-${kind}`).check();
  await page.getByTestId(`contact-save-${kind}`).click();
  await page.waitForSelector('[data-testid=toast-success]');
}

async function joinAndOptIn(page) {
  await page.goto(`${baseURL}/e/${SLUG}`);
  await waitHydrated(page);
  await page.getByTestId('join-button').click();
  await page.waitForSelector('[data-testid=member-panel]');
  await waitHydrated(page);
  await page.getByTestId('event-directory-toggle').check();
}

const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageA = await ctxA.newPage();
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageB = await ctxB.newPage();

await resetDb();

// One connection for the whole capture, used only by the slug pinning. Opened
// after the schema reset, because the reset drops the schema out from under any
// connection made before it.
const sql = postgres(databaseUrl, { max: 1 });

// ── Landing screenshots live in tests/e2e/landing.spec.ts ──────────────────
// The marketing page is static, so its shots (1280/360, en/ru) are written by
// the e2e gate on every run instead of being duplicated here. `overflow` at
// 360px is asserted in that spec as well.

// ── Account A ───────────────────────────────────────────────────────────────
await loginViaOtp(pageA, A.email);
await createProfile(pageA, A);
// Pin BEFORE the first screenshot: the editor prints the public address, so
// photographing it before the pin is what used to bake a random slug into it.
await pinPublicSlug(pageA, sql, PINNED_SLUG.alice);
await shoot(pageA, `${OUT}/profile-editor.png`, '[data-testid="pf-save"]');
await addContact(pageA, 'whatsapp', A.wa, true);
await addContact(pageA, 'phone', A.phone, false);

// public URL for the public-card shot
await pageA.goto(`${baseURL}/me`);
await settle(pageA);
const publicUrl = await pageA.getByTestId('public-url').textContent();
await shoot(pageA, `${OUT}/me-dashboard.png`, '[data-testid="public-url"]');

// event creation via organizer UI
await pageA.goto(`${baseURL}/organizer`);
await waitHydrated(pageA);
await pageA.getByTestId('ev-name').fill('Evidence Founders Mixer');
await pageA.locator('#ev-tz').selectOption('Europe/Madrid');
await pageA.locator('#ev-slug').fill(SLUG);
await pageA.getByTestId('ev-submit').click();
await pageA.waitForURL('**/organizer/events/**');
const eventId = pageA.url().split('/').pop();
await joinAndOptIn(pageA);

// ── Account B ───────────────────────────────────────────────────────────────
await loginViaOtp(pageB, B.email);
await createProfile(pageB, B);
// B's card is reachable from the directory capture, so it is pinned as well —
// the capture should not have a random public address anywhere in it.
await pinPublicSlug(pageB, sql, PINNED_SLUG.bob);
await addContact(pageB, 'whatsapp', B.wa, true);
await joinAndOptIn(pageB);
// grant organizer announcements at event scope (for the campaign audience)
await pageB.getByTestId('event-marketing-toggle').check();

// ── Campaign: create → approve → send ──────────────────────────────────────
await pageA.goto(`${baseURL}/organizer/events/${eventId}/campaigns`);
await waitHydrated(pageA);
await pageA.locator('#camp-body').fill('Reminder: networking hour starts at 18:00. Bring your QR!');
await pageA.getByRole('button', { name: 'Create draft' }).click();
await pageA.waitForSelector('[data-testid^="campaign-"]');
await pageA.locator('[data-testid^="campaign-approve-"]').click();
await pageA.waitForSelector('[data-testid^="campaign-send-"]');
const campaignSendButton = pageA.locator('[data-testid^="campaign-send-"]');
const campaignId = (await campaignSendButton.getAttribute('data-testid')).replace('campaign-send-', '');
await campaignSendButton.click();
await pageA.getByTestId('confirm-send').click();
// Wait for the send to land and the numbers to settle before photographing the
// report (see waitForCampaignSettled), then re-read it through the UI so the
// capture shows the same numbers the API just reported.
const settled = await waitForCampaignSettled(pageA, campaignId);
console.log(`campaign ${campaignId} settled: ${JSON.stringify(settled)}`);
await pageA.locator('[data-testid^="campaign-stats-"]').click();
await shoot(pageA, `${OUT}/organizer-campaign-stats.png`, '[data-testid^="stats-"]');

// ── Intro: B proposes, A answers → mutual ───────────────────────────────────
// ONLY ONE SIDE ANSWERS. ADR 0010 (docs-internal/adr/0010-initiator-consent-by-
// initiation.md): the initiator consents BY INITIATING, so B's consent row is
// written as `accept` when the request is created and B is never asked to answer
// their own request. This scenario used to have B accept a second time — written
// before ADR 0010, and never caught because the script had already started dying
// at the directory step, three screenshots earlier. With the directory fixed, the
// stale step surfaced as a 30s timeout waiting for a prompt the product
// deliberately no longer shows.
await pageB.goto(`${baseURL}/me/events/${eventId}/directory`);
await waitHydrated(pageB);
await shoot(pageB, `${OUT}/event-directory.png`, '[data-testid=member-list]');
await pageB.locator('[data-testid=member-list] li').first().getByRole('button').first().click();
// The first reveal kind is 'whatsapp', and A publishes one — so the mutual panel
// below has a real value to show rather than "nothing was revealed".
await pageB.locator('fieldset input[type=checkbox]').first().check();
await pageB.getByTestId('send-intro').click();
await pageB.waitForSelector('[data-testid=toast-success]');

await pageA.goto(`${baseURL}/me/introductions`);
await waitHydrated(pageA);
await pageA.locator('fieldset input[type=checkbox]').first().check();
await pageA.getByRole('button', { name: 'Accept' }).click();
await pageA.waitForTimeout(1200);

// The reveal panel belongs to the MUTUAL state, which A's accept just produced,
// so it is photographed after that answer rather than after a second one from B.
await pageB.goto(`${baseURL}/me/introductions`);
await waitHydrated(pageB);
await shoot(pageB, `${OUT}/intro-reveal-panel.png`, '[data-testid^="intro-revealed"]');

// ── Public card (fresh anonymous context, mobile) ──────────────────────────
const anon = await browser.newContext({ viewport: { width: 360, height: 780 } });
const anonPage = await anon.newPage();
await anonPage.goto(publicUrl);
await shoot(anonPage, `${OUT}/public-card-mobile.png`, '[data-testid="pubcard"]');
await anon.close();

await ctxA.close();
await ctxB.close();
await browser.close();
await sql.end({ timeout: 5 });
console.log('evidence screenshots written to', OUT);

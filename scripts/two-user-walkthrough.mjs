#!/usr/bin/env node
/**
 * THE TWO-PERSON WALKTHROUGH, LIVE, WITH SCREENSHOTS.
 *
 * Drives the whole journey the owner asked to see — A proposes an introduction,
 * B arrives at the card through the QR code a scanner would read, B accepts, and
 * the contact opens on both sides — against a REAL deployment, in a real browser,
 * and records what a person would have seen: one screenshot per meaningful step,
 * the measured wall-clock time from first paint to each step being usable, and
 * the console errors along the way.
 *
 * WHY THIS IS NOT A SPEC IN tests/e2e. That directory is the release gate, and a
 * gate that writes to a live deployment is not a gate. This is the evidence run
 * the brief asks for: documented and re-runnable, but not part of
 * `pnpm test:e2e`, and imported by nothing in the gate suite.
 *
 * USAGE (the target is MANDATORY — there is no default deployment to hit):
 *   node scripts/two-user-walkthrough.mjs --target=https://welcome.colmogravity.net
 *
 * WHAT IT WRITES, AND WHERE. Only inside evidence/two-user-walkthrough/ — the
 * PNGs and walkthrough-log.json. It never writes to the repository's source, and
 * it deploys, pushes and commits nothing.
 *
 * WHAT IT TOUCHES ON THE TARGET. Demo accounts only, whose OTP codes the
 * deployment exposes BY DESIGN (AUTH_EXPOSE_DEMO_OTP + a demo account's is_demo:
 * src/integrations/email/index.ts, scripts/seed-demo.mts): sign-ins, ONE
 * introduction between two synthetic demo personas in the existing demo event,
 * and the two consents that make it mutual. No identity is created, no profile or
 * contact is edited, and nothing else on the deployment is modified. The
 * per-account OTP guard allows 3 codes per 15 minutes, so the script can be
 * re-run at most ~3 times per quarter-hour per persona — that is the product
 * guarding its own door, not a limitation of this script.
 *
 * THE ONE THING THIS SCRIPT REFUSES TO CAPTURE. The operator's own account is a
 * member of the same demo event and has a mutual introduction of its own, and
 * both demo personas' introductions pages list it. A screenshot is a publication,
 * so every capture is scoped (an element, not the whole page, wherever the
 * surrounding page could carry the operator) and the captured text is checked
 * against REAL_PERSON_MARKERS: if one is present the shot is SKIPPED and the
 * reason is written into the log instead of the file. Contact values of the
 * SYNTHETIC personas are deliberately not masked — they are what the walkthrough
 * is evidence about.
 *
 * THE LOCALE. Every navigation carries `?lang=en` — a documented per-visit
 * override (src/i18n/locale.ts) — so the screenshots and the assertions read in
 * one language. It writes no account preference; the override lives in the URL
 * and in the visitor cookie.
 */
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'evidence', 'two-user-walkthrough');
const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/** The personas and the place: demo accounts this deployment already has. */
const A_EMAIL = 'demo2@welcome.test'; // Дмитрий Ковалёв — proposes
const B_EMAIL = 'marta.demo@welcome.test'; // Marta Ruiz — arrives through the QR, accepts
const EVENT_SLUG = 'welcome-demo-meetup';

/**
 * Real-person data this run must never publish. The operator's own account is in
 * this demo event and is a party to its own introductions; the walkthrough scopes
 * every capture away from it, and this guard is what proves the scoping held.
 */
const REAL_PERSON_MARKERS = ['nik_nikiti4', 'Nikita Berezniker'];

const target = (process.argv.slice(2).find((a) => a.startsWith('--target=')) ?? '').slice('--target='.length);
if (!target.startsWith('https://')) {
  console.error(
    'REFUSED: pass the deployment to walk through, e.g.\n'
    + '  node scripts/two-user-walkthrough.mjs --target=https://welcome.colmogravity.net',
  );
  process.exit(2);
}
const base = target.replace(/\/+$/, '');
mkdirSync(OUT, { recursive: true });

const log = {
  target: base,
  started_at: new Date().toISOString(),
  viewport: MOBILE,
  steps: [],
  screenshots: [],
  skipped_screenshots: [],
  friction: [],
  finished_at: null,
};

/** Every navigation goes through here, so the `?lang=en` override is never forgotten. */
const url = (pathname) => `${base}${pathname}${pathname.includes('?') ? '&' : '?'}lang=en`;

function note(severity, text) {
  log.friction.push({ severity, text });
  console.log(`  [${severity}] ${text}`);
}

/**
 * Writes one screenshot — unless the scope could publish a real person.
 *
 * `scope` is the locator being photographed: for an element shot the check reads
 * that element's own text, and for a full-page shot the whole document. Both
 * paths are the same guard, because a page whose surrounding cards are out of
 * frame is exactly as safe as its element's text. Where the page DOES carry a
 * marker, its location is recorded in the step's notes even when the capture is
 * safely scoped away from it — that is what tells a reviewer why a shot is
 * framed the way it is.
 */
async function capture(page, scope, name) {
  const pageText = await page.content();
  const onPage = REAL_PERSON_MARKERS.find((m) => pageText.includes(m));
  let located = null;
  if (onPage) {
    located = await page
      .evaluate((marker) => {
        const hits = [...document.querySelectorAll('body *')].filter(
          (el) => el.children.length === 0 && (el.textContent ?? '').includes(marker),
        );
        return hits.slice(0, 2).map((el) => {
          const id = el.closest('[data-testid]')?.getAttribute('data-testid');
          return `${el.tagName.toLowerCase()}${id ? ` in [data-testid=${id}]` : ''}: ${(el.textContent ?? '').trim().slice(0, 60)}`;
        });
      }, onPage)
      .catch(() => []);
  }

  const scopeText = scope ? await scope.innerText().catch(() => '') : pageText;
  const blocked = REAL_PERSON_MARKERS.find((m) => scopeText.includes(m));
  if (blocked) {
    log.skipped_screenshots.push({ name: `${name}.png`, reason: `captured text carries "${blocked}"`, where: located });
    note('blocked', `${name}.png SKIPPED: the captured text carries the real-person marker "${blocked}"`);
    return { file: null, note: null };
  }
  if (scope) await scope.scrollIntoViewIfNeeded().catch(() => {});
  const clip = scope ? await scope.boundingBox() : null;
  if (scope && !clip) {
    log.skipped_screenshots.push({ name: `${name}.png`, reason: 'the element was not visible' });
    return { file: null, note: null };
  }
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(OUT, file), fullPage: !clip, clip: clip ?? undefined });
  log.screenshots.push(file);
  console.log(`  shot: ${file}${clip ? ' (element)' : ''}`);
  return {
    file,
    note: located ? `captured away from the operator's row (${located.join(' | ')})` : null,
  };
}

/**
 * Runs one step, measures it, and captures its shots.
 *
 * Timings, per the brief ("wall-clock from first paint to the step being usable"):
 *   action_ms        — this step's own clock, from its first interaction (or
 *                      navigation) to the moment it was usable;
 *   nav_to_usable_ms — from this document's navigationStart to usable;
 *   fcp_to_usable_ms — from the document's first-contentful-paint to usable: the
 *                      number the brief names. Null when the document painted
 *                      before the step began (a click, not a navigation).
 */
async function step(name, page, fn, shots = []) {
  const started = Date.now();
  const entry = { name, started_at: new Date(started).toISOString(), shots: [], notes: [] };
  const errors = [];
  // Next's own RSC prefetches are aborted when a navigation lands — that is the
  // framework cancelling speculative work, not a failure a reader should see in
  // the friction list, so only the aborts of `?_rsc=` requests are dropped.
  const onConsole = (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300));
  const onFailed = (r) => {
    if (!r.failure()) return;
    if (r.url().includes('_rsc=') && r.failure().errorText.includes('ERR_ABORTED')) return;
    errors.push(`request failed: ${r.url()} (${r.failure().errorText})`);
  };
  page.on('console', onConsole);
  page.on('requestfailed', onFailed);
  try {
    await fn(entry);
  } finally {
    page.off('console', onConsole);
    page.off('requestfailed', onFailed);
  }
  const usable = Date.now();

  let metrics = null;
  try {
    metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paint = performance.getEntriesByName('first-contentful-paint')[0];
      return { timeOrigin: performance.timeOrigin, navStart: nav?.startTime ?? 0, fcp: paint?.startTime ?? null };
    });
  } catch {
    /* measuring a page that navigated away mid-step simply yields no metrics */
  }
  entry.action_ms = usable - started;
  entry.nav_to_usable_ms = metrics ? Math.round(usable - (metrics.timeOrigin + metrics.navStart)) : null;
  entry.fcp_to_usable_ms = metrics?.fcp != null ? Math.round(usable - (metrics.timeOrigin + metrics.fcp)) : null;
  entry.document_fcp_ms = metrics?.fcp != null ? Math.round(metrics.fcp) : null;
  entry.console_errors = errors;

  for (const shot of shots) {
    const scope = typeof shot.scope === 'function' ? shot.scope() : (shot.scope ?? null);
    const { file, note: frameNote } = await capture(page, scope, shot.name);
    if (file) entry.shots.push(file);
    if (frameNote) entry.notes.push(frameNote);
  }
  if (errors.length > 0) {
    entry.notes.push(`${errors.length} console/network error(s)`);
    for (const error of errors.slice(0, 3)) note('observed', `${name}: ${error}`);
  }
  log.steps.push(entry);
  console.log(`  ${name}: ${entry.action_ms}ms (fcp→usable ${entry.fcp_to_usable_ms ?? 'n/a'}ms)`);
}

/** The suite's sign-in, on the live deployment, through the real form. */
async function signIn(page, email) {
  await page.goto(url('/login'));
  await page.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
  await page.getByTestId('login-email').fill(email);
  const requested = page.waitForResponse((r) => r.url().includes('/api/auth/otp/request'));
  await page.getByTestId('login-request').click();
  const body = await (await requested).json();
  if (!body.devCode) {
    throw new Error(
      `${email}: the deployment exposed no demo code (AUTH_EXPOSE_DEMO_OTP/is_demo off, or the `
      + '3-codes-per-15-minutes guard already spent for this account)',
    );
  }
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL(/\/(me|onboarding)/, { timeout: 30_000 });
}

const browser = await chromium.launch();
const contextA = await browser.newContext({ viewport: MOBILE });
const contextB = await browser.newContext({ viewport: MOBILE });
const contextAnon = await browser.newContext({ viewport: MOBILE });
const pageA = await contextA.newPage();
const pageB = await contextB.newPage();
const pageAnon = await contextAnon.newPage();

try {
  // ── 1. A signs in and opens the event ─────────────────────────────────────
  await step('A signs in and opens the demo event', pageA, async () => {
    await signIn(pageA, A_EMAIL);
    await pageA.goto(url(`/e/${EVENT_SLUG}`));
    await pageA.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
    await pageA.getByTestId('member-panel').waitFor({ state: 'visible', timeout: 30_000 });
    const state = (await pageA.getByTestId('member-state').textContent())?.trim();
    console.log(`  A is a member: "${state}"`);
  }, [{ name: '01-a-event-member-state' }]);

  const aSlug = (await (await pageA.request.get(url('/me'))).text()).match(/\/p\/([A-Za-z0-9_-]+)/)?.[1];
  if (!aSlug) throw new Error('A has no public card slug on the dashboard');
  const cardUrl = `${base}/p/${aSlug}`;
  console.log(`  A's public card: ${cardUrl}`);

  // ── 2. A proposes the introduction, choosing what to reveal ───────────────
  let introId = null;
  await step('A opens the directory and proposes the introduction', pageA, async (entry) => {
    // The product's OWN path to the directory: the event page's member panel
    // links to it. That link carries the event's UUID, which matters — the same
    // page addressed by SLUG (a URL a person can paste) is a 500 on this
    // deployment; see the last step, which captures that.
    await pageA.goto(url(`/e/${EVENT_SLUG}`));
    await pageA.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
    await pageA.getByTestId('member-panel').waitFor({ state: 'visible', timeout: 30_000 });
    const link = pageA.getByTestId('event-directory-link');
    entry.notes.push(`the member panel links to ${await link.getAttribute('href')}`);
    await link.click();

    await pageA.getByRole('heading', { level: 1, name: 'Member directory' }).waitFor({ timeout: 30_000 });
    // The directory's default mode is `intent` ("they seek what I offer"); switch
    // to everyone, then narrow by search — both are the page's own controls, and
    // the narrowing keeps the operator's member row out of every capture.
    await pageA.getByTestId('dir-mode-all').click();
    await pageA.getByTestId('dir-search').fill('Marta');
    await pageA.getByTestId('dir-search').press('Enter');

    const directory = await (await pageA.request.get(url(`/api/events/${EVENT_SLUG}/directory?mode=all`))).json();
    const marta = (directory.members ?? []).find((m) => m.display_name === 'Marta Ruiz');
    if (!marta) {
      throw new Error(`Marta Ruiz is not in the directory: ${JSON.stringify(directory.members?.map((m) => m.display_name))}`);
    }
    entry.notes.push(`target profile ${marta.profile_id}`);

    const card = pageA.getByTestId(`member-${marta.profile_id}`);
    await card.waitFor({ state: 'visible', timeout: 30_000 });
    await card.getByTestId(`propose-${marta.profile_id}`).click();

    const chooser = pageA.getByRole('dialog');
    await chooser.waitFor({ state: 'visible', timeout: 15_000 });
    await chooser.getByLabel('Telegram username').check();
    const chooserShot = await capture(pageA, chooser, '02-a-reveal-chooser');
    if (chooserShot.file) entry.shots.push(chooserShot.file);
    if (chooserShot.note) entry.notes.push(chooserShot.note);

    const proposed = pageA.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/introductions'));
    await pageA.getByTestId('send-intro').click();
    const response = await proposed;
    const payload = await response.json();
    entry.notes.push(`POST /api/introductions → ${response.status()}, already_existed=${payload.already_existed}`);
    if (!response.ok()) throw new Error(`the proposal was refused: ${response.status()} ${JSON.stringify(payload)}`);
    if (payload.already_existed) {
      note(
        'blocked',
        'this pair already had an introduction in this event, so no fresh pending request could be created; '
        + 'the demo seed spends demo1↔demo2 and owner↔Marta, and this pair had already been walked',
      );
    }
    introId = payload.introduction.id;
    await card.getByTestId(`propose-${marta.profile_id}`).getByText('Request sent').waitFor({ timeout: 15_000 });
  }, [
    // Framed on the directory's own section (modes + search + member list) rather
    // than the whole page: the recommendation strip above it lists other members
    // of the same event, and nothing is gained by publishing their cards here.
    { name: '03-a-proposal-sent', scope: () => pageA.locator('section[aria-labelledby="dir-heading"]') },
  ]);

  // ── 3. B opens the card at the URL the QR encodes ────────────────────────
  await step('B signs in and opens the card from the QR URL', pageB, async (entry) => {
    await signIn(pageB, B_EMAIL);
    // The code the badge carries is the profile's QR (src/lib/qr.ts and the
    // qr.svg endpoint); the URL it encodes is the card URL, which Part A's local
    // spec proves by comparing the served module matrix with the encoder's. Here
    // the endpoint is read so the run records that the code was what was opened.
    const qr = await pageB.request.get(`${base}/api/public/profiles/${aSlug}/qr.svg`);
    if (!qr.ok()) throw new Error(`the QR endpoint answered ${qr.status()}`);
    const rows = (await qr.text()).split('M').length - 1;
    entry.notes.push(`QR read from /api/public/profiles/${aSlug}/qr.svg (${rows} module rows)`);

    await pageB.goto(cardUrl); // the URL the code encodes, opened as a scanner would
    await pageB.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
    await pageB.getByTestId('pubcard-name').waitFor({ state: 'visible', timeout: 30_000 });
    const name = (await pageB.getByTestId('pubcard-name').textContent())?.trim();
    entry.notes.push(`the card opens as "${name}"`);
    const cta = await pageB.getByTestId('pubcard-intro-cta').isVisible().catch(() => false);
    await pageB.getByTestId('pubcard-qr').click();
    await pageB.getByTestId('pubcard-qr-image').waitFor({ state: 'visible', timeout: 15_000 });
    entry.notes.push(cta ? 'the card offers the introduction (B shares the event)' : 'the card offered no introduction affordance');
    if (!cta) note('observed', 'B is already a member of this event, yet the card showed no introduction affordance');
  }, [{ name: '04-b-card-from-qr-url' }]);

  // ── 4. B opens the event ────────────────────────────────────────────────
  await step('B opens the event', pageB, async (entry) => {
    await pageB.goto(url(`/e/${EVENT_SLUG}`));
    await pageB.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
    await pageB.getByTestId('member-panel').waitFor({ state: 'visible', timeout: 30_000 });
    const memberState = await pageB.getByTestId('member-state').isVisible().catch(() => false);
    const joinButton = await pageB.getByTestId('join-button').isVisible().catch(() => false);
    entry.notes.push(`member state: ${memberState}, join action offered: ${joinButton}`);
    if (memberState && !joinButton) {
      note(
        'info',
        'B was ALREADY a member of this event (seeded), so there was no join to perform: the page shows the '
        + 'member state instead of a join action. The real join on a fresh account is covered by the local spec.',
      );
    }
  }, [{ name: '05-b-event-already-member' }]);

  // ── 5. B sees the request and accepts ────────────────────────────────────
  let acceptedLive = false;
  await step('B sees the request waiting and accepts it', pageB, async (entry) => {
    await pageB.goto(url('/me/introductions'));
    await pageB.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
    const section = pageB.getByTestId(`intro-${introId}`);
    await section.waitFor({ state: 'visible', timeout: 30_000 });
    const stateText = (await pageB.getByTestId(`intro-state-${introId}`).textContent())?.trim() ?? '';
    entry.notes.push(`the card reads "${stateText}"`);
    const revealedBefore = await pageB.getByTestId(`intro-revealed-${introId}`).count();
    const drawerBefore = await (await pageB.request.get(url(`/api/introductions/${introId}`))).json();
    entry.notes.push(`before consent: state=${drawerBefore.introduction.state} revealed=${JSON.stringify(drawerBefore.revealed)} reveal blocks=${revealedBefore}`);
    if (drawerBefore.introduction.state === 'pending' && (revealedBefore !== 0 || drawerBefore.revealed.length !== 0)) {
      note('defect', 'a pending introduction revealed contacts');
    }
    // Captured HERE, before the accept, because the step's own shots are taken
    // when the step is done — and by then this card is mutual. The file is named
    // for the state it actually caught: this pair can only be answered ONCE (the
    // product keeps one introduction per pair per event context), so on a re-run
    // the honest artefact is the mutual card, not a file called "pending" holding
    // a mutual picture.
    const pendingShot = await capture(
      pageB,
      section,
      drawerBefore.introduction.state === 'pending' ? '06-b-proposal-pending' : '06-b-intro-card-already-answered',
    );
    if (pendingShot.file) entry.shots.push(pendingShot.file);
    if (pendingShot.note) entry.notes.push(pendingShot.note);

    if (drawerBefore.introduction.state !== 'pending') {
      // The product keeps ONE introduction per pair per event context, and this
      // pair's was made mutual by the first run of this walkthrough. There is
      // nothing left to accept, and pretending otherwise would be worse than
      // saying so: the acceptance itself is evidenced by that run's log
      // (`POST /respond → 200`, `before consent: state=pending revealed=[]`).
      note(
        'info',
        'the introduction for this pair is already mutual (the first run of this walkthrough answered it), so '
        + 'there was no pending request to accept again: the card is captured in the state it is actually in',
      );
      return;
    }
    if (revealedBefore !== 0) return;

    await section.getByLabel('Telegram username').check();
    await section.getByLabel('WhatsApp number').check();
    const accepted = pageB.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/respond'));
    await section.getByTestId(`intro-accept-${introId}`).click();
    const response = await accepted;
    entry.notes.push(`POST /respond → ${response.status()}`);
    if (!response.ok()) throw new Error(`the accept was refused: ${response.status()}`);
    acceptedLive = true;
    await pageB.getByTestId(`intro-state-${introId}`).getByText('Mutual').waitFor({ timeout: 15_000 });
    const drawerAfter = await (await pageB.request.get(url(`/api/introductions/${introId}`))).json();
    entry.notes.push(`B after consent: state=${drawerAfter.introduction.state} revealed=${JSON.stringify(drawerAfter.revealed)}`);
    const rows = await section.getByTestId(`intro-revealed-${introId}`).locator('li').count();
    entry.notes.push(`B's revealed rows: ${rows}`);
    if (rows === 0) note('defect', "B's mutual card rendered no revealed contact");
  }, [{ name: '07-b-mutual-reveal', scope: () => pageB.getByTestId(`intro-${introId}`) }]);

  // ── 6. A's side of the mutual moment ─────────────────────────────────────
  await step('A sees the mutual state and the reveal', pageA, async (entry) => {
    await pageA.goto(url('/me/introductions'));
    await pageA.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
    await pageA.getByTestId(`intro-state-${introId}`).getByText('Mutual').waitFor({ timeout: 30_000 });
    const reveal = pageA.getByTestId(`intro-revealed-${introId}`);
    await reveal.waitFor({ state: 'visible', timeout: 15_000 });
    const rows = await reveal.locator('li').count();
    const drawer = await (await pageA.request.get(url(`/api/introductions/${introId}`))).json();
    entry.notes.push(`A after consent: revealed=${JSON.stringify(drawer.revealed)} revealed rows=${rows}`);
    if (rows === 0) note('defect', "A's mutual card rendered no revealed contact");
  }, [{ name: '08-a-mutual-reveal', scope: () => pageA.getByTestId(`intro-${introId}`) }]);

  // ── 7. A's public card as a stranger sees it ─────────────────────────────
  await step('a stranger opens A’s public card at phone size', pageAnon, async (entry) => {
    await pageAnon.goto(cardUrl);
    await pageAnon.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
    await pageAnon.getByTestId('pubcard-name').waitFor({ state: 'visible', timeout: 30_000 });
    await pageAnon.getByTestId('pubcard-qr').click();
    await pageAnon.getByTestId('pubcard-qr-image').waitFor({ state: 'visible', timeout: 15_000 });
    const name = (await pageAnon.getByTestId('pubcard-name').textContent())?.trim();
    const contacts = await pageAnon.getByTestId('pubcard-links').count();
    entry.notes.push(`the card renders as "${name}" with ${contacts} public contact row(s)`);
  }, [{ name: '09-a-public-card-stranger' }]);

  // ── 8. The same directory on a desktop viewport ───────────────────────────
  const contextDesktop = await browser.newContext({ viewport: DESKTOP, storageState: await contextA.storageState() });
  const pageDesktop = await contextDesktop.newPage();
  try {
    await step('the directory at desktop size', pageDesktop, async (entry) => {
      await pageDesktop.goto(url(`/e/${EVENT_SLUG}`));
      await pageDesktop.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
      await pageDesktop.getByTestId('event-directory-link').click();
      await pageDesktop.getByTestId('dir-mode-all').click();
      await pageDesktop.getByTestId('dir-search').fill('Marta');
      await pageDesktop.getByTestId('dir-search').press('Enter');
      await pageDesktop.getByTestId('member-list').waitFor({ state: 'visible', timeout: 30_000 });
      entry.notes.push('the same view at 1280px, narrowed by the same search (A’s session reused, no second sign-in)');
    }, [{ name: '10-directory-desktop-1280', scope: () => pageDesktop.locator('section[aria-labelledby="dir-heading"]') }]);

    // ── 9. THE DEFECT THIS RUN FOUND: the same page at its slug URL ─────────
    // `/me/events/<slug>/directory` is a URL a person can paste or bookmark, and
    // the API route behind it accepts a slug — but the PAGE queried
    // `WHERE id = $1 OR slug = $1`, and Postgres casts that literal to uuid, so
    // the request died with `invalid input syntax for type uuid` and the segment
    // error surface replaced the page. Reproduced here on the live deployment, and
    // locally with the full error. The page's query is fixed in the working tree
    // (branch on isUuid, exactly like src/app/api/events/[eventIdOrSlug]/
    // directory/route.ts) but NOT deployed, so this captures the live state.
    await step('the directory at its slug URL (the deployed defect)', pageDesktop, async (entry) => {
      await pageDesktop.goto(url(`/me/events/${EVENT_SLUG}/directory`));
      await pageDesktop.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
      await pageDesktop.waitForTimeout(3000);
      const main = await pageDesktop.locator('main').count();
      const tabs = await pageDesktop.getByTestId('dir-mode-all').count();
      entry.notes.push(`slug URL → main=${main}, directory controls=${tabs}`);
      if (tabs === 0) note('defect', 'the directory page is a 500 when addressed by event slug (uuid works)');
    }, [{ name: '11-defect-directory-slug-url' }]);
  } finally {
    await contextDesktop.close();
  }

  // ── 10. A pending card, seen by its recipient, on a pair this run did not
  //     spend. Only when B could not accept above: the walkthrough's own pair is
  //     mutual by now (the product keeps one introduction per pair per event), so
  //     the pending STATE would otherwise be missing from the picture.
  if (!acceptedLive) {
    const contextC = await browser.newContext({ viewport: MOBILE });
    const pageC = await contextC.newPage();
    try {
      await step('supplement: a pending request as its recipient sees it', pageC, async (entry) => {
        await signIn(pageC, 'demo1@welcome.test'); // Анна Смирнова — a synthetic persona
        await pageC.goto(url('/me/introductions'));
        await pageC.waitForSelector('html[data-hydrated="true"]', { timeout: 30_000 });
        const pending = pageC
          .locator('section[data-testid^="intro-"]')
          .filter({ hasText: 'Waiting for your answer' });
        await pending.first().waitFor({ state: 'visible', timeout: 30_000 });
        const shot = await capture(pageC, pending.first(), '12-supplement-pending-card');
        if (shot.file) entry.shots.push(shot.file);
        if (shot.note) entry.notes.push(shot.note);
        entry.notes.push('a different pair (seeded outside this walkthrough), captured read-only — nothing was answered');
      });
    } catch (error) {
      note('observed', `the supplement shot could not be taken: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await contextC.close();
    }
  }
} catch (error) {
  note('blocked', `the walkthrough stopped: ${error instanceof Error ? error.message : String(error)}`);
  log.aborted = true;
} finally {
  log.finished_at = new Date().toISOString();
  // Every run is kept: the product allows ONE introduction per pair per event, so
  // a later run cannot repeat the pending→mutual transition of the first and the
  // two logs are evidence of different moments, not duplicates.
  const file = path.join(OUT, 'walkthrough-log.json');
  let runs = [];
  if (existsSync(file)) {
    try {
      const previous = JSON.parse(readFileSync(file, 'utf8'));
      runs = Array.isArray(previous?.runs) ? previous.runs : [previous];
    } catch {
      runs = [];
    }
  }
  runs.push(log);
  writeFileSync(file, `${JSON.stringify({ runs }, null, 2)}\n`, 'utf8');
  await browser.close();
}

console.log(
  `\nsteps: ${log.steps.length}, screenshots: ${log.screenshots.length}, `
  + `skipped: ${log.skipped_screenshots.length}, friction: ${log.friction.length}`,
);
for (const item of log.friction) console.log(`  [${item.severity}] ${item.text}`);
if (log.aborted) process.exit(1);

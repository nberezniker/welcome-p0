import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import QRCode from 'qrcode';
import { en } from '../../src/i18n/en';

/**
 * THE WHOLE TWO-PERSON JOURNEY, IN ONE TEST, WITH BOTH PEOPLE IN THE ROOM.
 *
 * This is the flow the owner describes as "one invited, the second opened the
 * QR, and off it goes": A proposes an introduction, B arrives at the card
 * through the QR code a scanner would read, and the contact is revealed on both
 * sides once both agreed. Every other spec in this directory proves ONE half of
 * it (intro-calendar.spec.ts drives the mutual card, card-contacts-qr.spec.ts
 * the card's contacts and its QR) — none of them walks the two halves with two
 * sessions and a real transition, which is what this file is for.
 *
 * ── WHAT IS DRIVEN THROUGH THE UI AND WHAT IS NOT ───────────────────────────
 * The journey itself is driven through the UI, because the journey is what is
 * being judged: sign-in (login form), opening the event, joining it, the
 * directory visibility toggle, the proposal with its reveal chooser, the
 * acceptance with its reveal checkboxes, and every state read afterwards. The
 * FIXTURES around it — profile, contacts, the event itself — go through the
 * public APIs, exactly as the rest of this suite does (see the `seedCard` note
 * in card-contacts-qr.spec.ts): they are setup, not the thing under test, and
 * an onboarding form in the middle of a flow test would hide the flow.
 *
 * ── THE ORDER OF THE TWO HALVES IS THE PRODUCT'S, NOT THE BRIEF'S ───────────
 * The brief's narrative is "A proposes → B joins → B answers". The product does
 * not allow that order, and this spec asserts the rule rather than stepping
 * around it: `POST /api/introductions` with an `event_id` answers
 * `403 target_not_member` unless the OTHER side is already an active member of
 * that event (src/app/api/introductions/route.ts), and BOTH UI entry points —
 * the event directory and the card's CTA — always send `event_id`
 * (directory-panel.tsx, src/app/p/[slug]/intro-cta.tsx). An event-context
 * introduction therefore cannot be addressed to someone who has not joined yet:
 * B is in the room first, then A proposes. The constraint is asserted below, at
 * the one moment it is observable, so the reason this test's order differs from
 * the brief stays in the evidence instead of in a comment.
 *
 * ── THE QR IS READ, NOT GUESSED ─────────────────────────────────────────────
 * "Do not shortcut to a different route" is taken literally: the spec fetches
 * the QR SVG that A's own dashboard displays, parses the MODULE BITMAP out of
 * the served bytes, and proves that bitmap is exactly `qrcode`'s encoding of the
 * card URL (the same library the endpoint renders with, so the matrices are
 * comparable byte-for-byte). Only then does B navigate — to the URL the code
 * proved to encode — with the event URL and B's own card as NEGATIVE controls,
 * so a code that merely encodes "some URL" cannot pass. A full QR decoder would
 * be a new dependency for one assertion; matrix equality against the encoder is
 * the same statement without it.
 *
 * ── THE PRIVACY BOUNDARY, ASSERTED AT EVERY STOP ────────────────────────────
 * A's telegram handle and phone are created PRIVATE (public_enabled = false):
 * they are on no public card anywhere. The telegram handle is revealed only
 * through this introduction; the phone is in nobody's reveal set and must not
 * surface at all. So the same three assertions carry the whole boundary:
 *   · before consent — no reveal block on either side, and the drawer API
 *     answers `revealed: []` (and does not carry the values in its body);
 *   · after consent — exactly ONE revealed row per side, the expected value,
 *     and no other contact value anywhere on the page;
 *   · a stranger's card — the private values are absent, and the only CTA a
 *     visitor without a shared event gets is the sign-in one.
 */

const A_EMAIL = 'walkthrough-anna@example.org';
const B_EMAIL = 'walkthrough-boris@example.org';
const A_NAME = 'Anna Walkthrough';
const B_NAME = 'Boris Walkthrough';
const EVENT_SLUG = 'e2e-two-user-walkthrough';
const EVENT_NAME = 'E2E Two-User Walkthrough';

/**
 * The reveal fixture. A's handle is PRIVATE on purpose: a value that is on no
 * public card can only reach B through the introduction, which is exactly the
 * claim "the reveal is scoped to the introduction". A's phone is private and in
 * nobody's reveal set. B's phone is private and outside A's reveal set, so it
 * must never appear on A's side even though B does tick it — the intersection
 * is what decides, not the asking.
 */
const A_TELEGRAM = '@anna_walkthrough_private';
const A_PHONE = '+34 600 700 001';
const B_TELEGRAM = '@boris_walkthrough';
const B_PHONE = '+34 600 700 002';

const MOBILE = { width: 390, height: 844 };

const KIND_LABEL = {
  telegram_username: en['contacts.kind.telegram_username'],
  phone: en['contacts.kind.phone'],
};

/** Client JS is live once the layout's HydrationMarker has run. */
async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

/** The suite's sign-in: real form, real OTP, real session cookie. */
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

/** A profile and its contacts, through the public APIs (the suite's fixture path). */
async function seedProfile(
  page: Page,
  displayName: string,
  contacts: ReadonlyArray<{ kind: string; value: string; public_enabled: boolean }>,
): Promise<void> {
  const profile = await page.request.post('/api/me/profile', {
    data: { display_name: displayName, languages: ['en'] },
  });
  expect(profile.status(), `profile for ${displayName}: ${await profile.text()}`).toBe(200);
  for (const contact of contacts) {
    const saved = await page.request.put('/api/me/contacts', { data: contact });
    expect(saved.status(), `PUT ${contact.kind}: ${await saved.text()}`).toBe(200);
  }
}

/** The card's slug, read off the dashboard the way its owner reads it. */
async function publicSlug(page: Page): Promise<string> {
  await page.goto('/me');
  await waitHydrated(page);
  const url = (await page.getByTestId('public-url').textContent())?.trim() ?? '';
  expect(url, 'the dashboard must show the public card URL').toContain('/p/');
  return url.split('/p/')[1]!.trim();
}

/**
 * The module bitmap of a QR the endpoint rendered, read out of the SVG it sent.
 *
 * `qrcode`'s SVG renderer (node_modules/qrcode/lib/renderer/svg-tag.js) emits one
 * subpath per row of the symbol: `M{col+margin} {row+margin+0.5}` at the row's
 * first dark module, then `h{n}` for a run of n dark modules and `m{dx} 0` for a
 * gap — nothing else appears in the dark path, so this parse is exact rather
 * than heuristic. `margin` is 1 because that is what src/lib/qr.ts and the
 * qr.svg endpoint render with.
 */
function servedQrBitmap(svg: string): string {
  const box = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!box) throw new Error('the served QR has no viewBox');
  const margin = 1;
  const size = Number(box[1]) - margin * 2;
  const dark = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const path = svg.match(/<path stroke="#000000" d="([^"]*)"/);
  if (!path) throw new Error('the served QR has no dark path');
  const darkPath = path[1];
  if (darkPath === undefined) throw new Error('the served QR has an empty dark path');

  for (const rowSubpath of darkPath.split('M').slice(1)) {
    const head = rowSubpath.match(/^([\d.]+)\s+([\d.]+)/);
    if (!head) throw new Error(`unparsable QR row: ${rowSubpath.slice(0, 40)}`);
    const row = Math.round(Number(head[2]) - margin - 0.5);
    let x = Number(head[1]) - margin;
    for (const token of rowSubpath.slice(head[0].length).match(/[hm][\d.]+(?:\s[\d.]+)?/g) ?? []) {
      const [, cmd, amount] = token.match(/^([hm])([\d.]+)/)!;
      const n = Number(amount);
      if (cmd === 'h') {
        for (let i = 0; i < n; i += 1) {
          if (row >= 0 && row < size && x + i >= 0 && x + i < size) dark[row]![x + i] = true;
        }
      }
      x += n;
    }
  }
  return dark.map((line) => line.map((on) => (on ? '1' : '0')).join('')).join('\n');
}

/** What `qrcode` itself encodes for `url` — from the encoder, not from a parser. */
function encodedQrBitmap(url: string): string {
  const { modules } = QRCode.create(url);
  const size = modules.size;
  const lines: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let line = '';
    for (let col = 0; col < size; col += 1) line += modules.data[row * size + col] ? '1' : '0';
    lines.push(line);
  }
  return lines.join('\n');
}

/** The drawer, read directly — the per-party payload the card renders from. */
async function drawer(page: Page, introId: string) {
  const res = await page.request.get(`/api/introductions/${introId}`);
  const raw = await res.text();
  expect(res.status(), raw).toBe(200);
  return { raw, body: JSON.parse(raw) as { introduction: { state: string; my_decision: string; other_accepted: boolean }; revealed: unknown[] } };
}

/** Nothing on this page may carry a private contact value that was not revealed here. */
function expectNoLeak(html: string, values: readonly string[], where: string) {
  for (const value of values) {
    expect(html, `${where} must not carry ${value}`).not.toContain(value);
  }
}

test('two users: A proposes, B arrives through the QR and accepts, and the contact opens on both sides', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const contexts: BrowserContext[] = [];

  try {
    // ── A: signs in, becomes somebody's counterpart, opens an event, joins it ─
    await page.setViewportSize(MOBILE);
    await loginViaOtp(page, A_EMAIL);
    await seedProfile(page, A_NAME, [
      { kind: 'telegram_username', value: A_TELEGRAM, public_enabled: false },
      { kind: 'phone', value: A_PHONE, public_enabled: false },
    ]);

    const created = await page.request.post('/api/organizer/events', {
      data: { name: EVENT_NAME, slug: EVENT_SLUG, mode: 'offline', access_mode: 'public', timezone: 'Europe/Madrid' },
    });
    expect(created.status(), `event create: ${await created.text()}`).toBe(201);
    const event = ((await created.json()) as { event: { id: string; slug: string } }).event;

    await page.goto(`/e/${event.slug}`);
    await waitHydrated(page);
    await page.getByTestId('join-button').click();
    await expect(page.getByTestId('member-panel'), 'A joins the event through the join button').toBeVisible({
      timeout: 30_000,
    });
    await waitHydrated(page);
    // A must be VISIBLE in the directory or A is not a member anybody can see.
    // The write is confirmed against its own response, not the optimistic box.
    const patchedA = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/me/memberships/'));
    await page.getByTestId('event-directory-toggle').check();
    expect((await patchedA).status()).toBe(200);
    await expect(page.getByTestId('event-directory-toggle')).toBeChecked();
    console.log(`[walkthrough] A: profile, contacts, event /e/${event.slug}, joined, directory-visible`);

    // ── The product's rule, asserted where it is observable ───────────────────
    // An event-context introduction can only be addressed to an ACTIVE MEMBER of
    // that event: `POST /api/introductions` with `event_id` answers
    // `403 target_not_member` otherwise (src/app/api/introductions/route.ts), and
    // the directory the UI proposes from lists active members only
    // (src/app/api/events/[eventIdOrSlug]/directory/route.ts). So while B is
    // outside the event there is literally nobody for A to propose to — which is
    // why this test brings B into the room BEFORE A proposes, and why the
    // brief's narrative order (propose first, join after) is not reachable
    // through the UI at all. Asserted, not assumed:
    await page.goto(`/me/events/${event.id}/directory`);
    await waitHydrated(page);
    await expect(page.getByTestId('directory-empty'), 'nobody to propose to yet').toBeVisible({ timeout: 30_000 });
    const emptyDirectory = await page.request.get(`/api/events/${event.slug}/directory?mode=all`);
    expect(
      ((await emptyDirectory.json()) as { members: unknown[] }).members,
      'A is the only member, and a directory never lists the reader',
    ).toEqual([]);
    console.log('[walkthrough] A: directory is empty — the invitation has no recipient until B joins');

    // ── A's QR: read off the dashboard, proven to encode the card URL ─────────
    const aSlug = await publicSlug(page);
    const origin = new URL(page.url()).origin;
    const cardUrl = `${origin}/p/${aSlug}`;
    const qrPath = `/api/public/profiles/${aSlug}/qr.svg`;
    // The dashboard shows the code this journey is about; the src must be the
    // endpoint, or the thing below is being read from somewhere A never sees.
    await expect(page.getByTestId('qr-image')).toHaveAttribute('src', qrPath);

    const qrResponse = await page.request.get(qrPath);
    expect(qrResponse.status(), `GET ${qrPath}`).toBe(200);
    const served = servedQrBitmap(await qrResponse.text());
    expect(served.split('\n').length, 'the served code is a QR of a sane size').toBeGreaterThan(20);
    // Positive: the served modules ARE the encoding of A's card URL.
    expect(served, 'the QR A shows must encode exactly A’s public card URL').toBe(encodedQrBitmap(cardUrl));
    // Negative controls: it is not the event's URL and not "any URL at all".
    expect(served, 'the QR must not encode the event URL').not.toBe(encodedQrBitmap(`${origin}/e/${event.slug}`));
    expect(served, 'the QR must not encode the dashboard').not.toBe(encodedQrBitmap(`${origin}/me`));
    console.log(`[walkthrough] A: QR read from ${qrPath} → ${cardUrl} (verified against the encoder)`);

    // ── B: signs in, and arrives at the card through the QR ───────────────────
    const ctxB = await browser.newContext({ viewport: MOBILE });
    contexts.push(ctxB);
    const pageB = await ctxB.newPage();
    await loginViaOtp(pageB, B_EMAIL);
    await seedProfile(pageB, B_NAME, [
      { kind: 'telegram_username', value: B_TELEGRAM, public_enabled: true },
      { kind: 'phone', value: B_PHONE, public_enabled: false },
    ]);

    // The navigation target IS the URL the QR proved to encode — no other route.
    await pageB.goto(cardUrl);
    await waitHydrated(pageB);
    await expect(pageB.getByTestId('pubcard-name')).toHaveText(A_NAME);
    // Signed in, but in no event with A yet: the card offers sign-in, because the
    // introduction affordance is event-scoped. Honest, and a friction worth
    // recording: B is already signed in when B reads "Sign in to connect".
    await expect(pageB.getByTestId('pubcard-signin-cta')).toBeVisible();
    await expect(pageB.getByTestId('pubcard-intro-cta'), 'no shared event, no intro affordance').toHaveCount(0);
    console.log('[walkthrough] B: arrived at the card from the QR URL (no shared event yet → sign-in CTA)');

    // ── B: opens the event and joins it through the join button ───────────────
    await pageB.goto(`/e/${event.slug}`);
    await waitHydrated(pageB);
    await expect(pageB.getByTestId('join-button'), 'a non-member sees the join action').toBeVisible();
    await pageB.getByTestId('join-button').click();
    await expect(pageB.getByTestId('member-panel'), 'B joins through the join button').toBeVisible({ timeout: 30_000 });
    await waitHydrated(pageB);
    const patchedB = pageB.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/me/memberships/'));
    await pageB.getByTestId('event-directory-toggle').check();
    expect((await patchedB).status()).toBe(200);
    await expect(pageB.getByTestId('member-panel')).toContainText(en['event.memberPanelTitle']);
    console.log('[walkthrough] B: joined the event, directory-visible');

    // Now that B is in the room, the QR card offers the introduction — the same
    // URL B scanned a moment ago, with one more affordance on it.
    await pageB.goto(cardUrl);
    await waitHydrated(pageB);
    await expect(pageB.getByTestId('pubcard-intro-cta'), 'a shared event turns the card into an intro').toBeVisible();
    await expect(pageB.getByTestId('pubcard-signin-cta')).toHaveCount(0);

    // ── A: proposes the introduction, choosing what to reveal ────────────────
    await page.goto(`/me/events/${event.id}/directory`);
    await waitHydrated(page);
    await expect(page.getByRole('heading', { level: 1, name: en['directory.title'] })).toBeVisible();
    // The directory's default mode depends on the VIEWER: "they seek what I offer"
    // when the viewer declares offers, and "Everyone" when they declare none,
    // because intent mode is empty by construction for such a viewer
    // (defaultModeForViewer, src/domain/directory-filters.ts). A declares no
    // offers, so the page must open able to show people — without the visitor
    // having to discover the mode control.
    await expect(page.getByTestId('dir-mode-all'), 'a viewer with no offers opens on Everyone').toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByTestId('member-list')).toBeVisible({ timeout: 30_000 });
    // The narrowed mode is still the honest empty answer when asked for
    // explicitly — that is what the hint exists for.
    await page.goto(`/me/events/${event.id}/directory?mode=intent`);
    await waitHydrated(page);
    await expect(page.getByTestId('directory-empty')).toHaveText(en['dir.modeHintIntent'], { timeout: 30_000 });
    await page.goto(`/me/events/${event.id}/directory`);
    const directory = await page.request.get(`/api/events/${event.slug}/directory?mode=all`);
    expect(directory.status(), await directory.text()).toBe(200);
    const members = ((await directory.json()) as { members: { profile_id: string; display_name: string }[] }).members;
    const boris = members.find((m) => m.display_name === B_NAME);
    expect(boris, `B must be visible to A: ${JSON.stringify(members.map((m) => m.display_name))}`).toBeTruthy();

    const bCard = page.getByTestId(`member-${boris!.profile_id}`);
    await expect(page.getByTestId('member-list'), 'B appears once the mode shows everyone').toBeVisible({ timeout: 30_000 });
    await expect(bCard.getByRole('heading', { name: B_NAME })).toBeVisible({ timeout: 30_000 });
    await bCard.getByTestId(`propose-${boris!.profile_id}`).click();
    const chooserTitle = en['directory.revealChooserTitle'].replace('{name}', B_NAME);
    const chooser = page.getByRole('dialog', { name: chooserTitle });
    await expect(chooser.getByRole('heading', { name: chooserTitle })).toBeVisible();
    // The hint that explains the intersection rule is rendered twice BY DESIGN —
    // visibly, and as the fieldset's `sr-only` legend (directory-panel.tsx) — so
    // the scoped, visible copy is what this asserts.
    await expect(
      chooser.getByRole('paragraph').filter({ hasText: en['directory.revealChooserHint'] }),
    ).toBeVisible();
    await chooser.getByLabel(KIND_LABEL.telegram_username).check();
    const proposed = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/introductions'));
    await page.getByTestId('send-intro').click();
    const proposedRes = await proposed;
    expect(proposedRes.status(), await proposedRes.text()).toBe(200);
    const proposal = (await proposedRes.json()) as { introduction: { id: string }; already_existed: boolean };
    expect(proposal.already_existed, 'this must be a FRESH proposal, not an idempotent re-hit').toBe(false);
    const introId = proposal.introduction.id;
    // A sees the request went, on the card it was sent from.
    await expect(bCard.getByTestId(`propose-${boris!.profile_id}`)).toHaveText(en['directory.proposed']);
    await expect(page.getByText(en['directory.introSentToast'])).toBeVisible();
    console.log(`[walkthrough] A: proposed introduction ${introId} (reveal: telegram_username)`);

    // ── A's card is WAITING, and carries no reveal ───────────────────────────
    await page.goto('/me/introductions');
    await waitHydrated(page);
    await expect(page.getByRole('heading', { level: 1, name: en['intros.title'] })).toBeVisible();
    await expect(page.getByTestId(`intro-state-${introId}`)).toHaveText(en['intros.state.pending']);
    await expect(page.getByTestId(`intro-${introId}`)).toContainText(
      en['intros.otherPending'].replace('{name}', B_NAME),
    );
    await expect(page.getByTestId(`intro-revealed-${introId}`), 'pending reveals nothing to A').toHaveCount(0);
    const drawerA = await drawer(page, introId);
    expect(drawerA.body.introduction.state).toBe('pending');
    expect(drawerA.body.introduction.my_decision, 'the initiator consented by requesting (ADR 0010)').toBe('accept');
    expect(drawerA.body.introduction.other_accepted).toBe(false);
    expect(drawerA.body.revealed, 'pending reveals nothing to A').toEqual([]);
    expectNoLeak(drawerA.raw, [A_TELEGRAM, A_PHONE, B_TELEGRAM, B_PHONE], 'A’s pending drawer');
    await expect(page.getByTestId(`intro-calendar-${introId}`), 'no agreement, no meeting control').toHaveCount(0);
    expectNoLeak(await page.content(), [A_TELEGRAM, A_PHONE, B_TELEGRAM, B_PHONE], 'A’s pending cabinet');

    // ── B: sees the request waiting for an answer, and still nothing revealed ─
    await pageB.goto('/me/introductions');
    await waitHydrated(pageB);
    await expect(pageB.getByRole('heading', { level: 1, name: en['intros.title'] })).toBeVisible();
    await expect(pageB.getByTestId(`intro-state-${introId}`)).toHaveText(en['intros.state.pending']);
    await expect(pageB.getByTestId(`intro-${introId}`)).toContainText(en['intros.waitingForYou']);
    await expect(pageB.getByTestId(`intro-revealed-${introId}`), 'pending reveals nothing to B').toHaveCount(0);
    const drawerB = await drawer(pageB, introId);
    expect(drawerB.body.revealed, 'pending reveals nothing to B').toEqual([]);
    expectNoLeak(drawerB.raw, [A_TELEGRAM, A_PHONE, B_TELEGRAM, B_PHONE], 'B’s pending drawer');
    expectNoLeak(await pageB.content(), [A_TELEGRAM, A_PHONE, B_TELEGRAM, B_PHONE], 'B’s pending cabinet');

    // ── B: accepts, asking for telegram AND phone ────────────────────────────
    // The phone is asked for on purpose: A only offered telegram, so the
    // intersection must still keep it out. Asking is not consenting.
    const sectionB = pageB.getByTestId(`intro-${introId}`);
    await expect(sectionB.getByText(en['intros.revealFieldsLabel'])).toBeVisible();
    await sectionB.getByLabel(KIND_LABEL.telegram_username).check();
    await sectionB.getByLabel(KIND_LABEL.phone).check();
    const accepted = pageB.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/respond'));
    await sectionB.getByTestId(`intro-accept-${introId}`).click();
    expect((await accepted).status(), 'accept must be recorded').toBe(200);

    // ── The mutual moment, on B's side ───────────────────────────────────────
    await expect(pageB.getByTestId(`intro-state-${introId}`)).toHaveText(en['intros.state.mutual']);
    const revealB = pageB.getByTestId(`intro-revealed-${introId}`);
    await expect(revealB).toBeVisible();
    await expect(revealB).toContainText(
      en['intros.revealedFrom'].replace('{name}', A_NAME),
    );
    await expect(revealB.locator('li'), 'exactly one kind was agreed — the intersection').toHaveCount(1);
    await expect(revealB.locator('li').first()).toContainText(KIND_LABEL.telegram_username);
    await expect(revealB.locator('li').first()).toContainText(A_TELEGRAM);
    expectNoLeak(await pageB.content(), [A_PHONE, B_PHONE], 'B’s mutual cabinet');
    const drawerBAfter = await drawer(pageB, introId);
    expect(drawerBAfter.body.introduction.state).toBe('mutual');
    expect(drawerBAfter.body.revealed, 'B sees A’s telegram, and nothing else').toEqual([
      { kind: 'telegram_username', value: A_TELEGRAM },
    ]);
    console.log(`[walkthrough] B: accepted → mutual, reveal = ${JSON.stringify(drawerBAfter.body.revealed)}`);

    // ── The mutual moment, on A's side ───────────────────────────────────────
    await page.goto('/me/introductions');
    await waitHydrated(page);
    await expect(page.getByTestId(`intro-state-${introId}`)).toHaveText(en['intros.state.mutual']);
    const revealA = page.getByTestId(`intro-revealed-${introId}`);
    await expect(revealA).toBeVisible({ timeout: 15_000 });
    await expect(revealA).toContainText(en['intros.mutualNote']);
    await expect(revealA.locator('li'), 'exactly one kind was agreed — the intersection').toHaveCount(1);
    await expect(revealA.locator('li').first()).toContainText(KIND_LABEL.telegram_username);
    await expect(revealA.locator('li').first()).toContainText(B_TELEGRAM);
    // A's own private values are not on A's page, and B's phone is not revealed.
    expectNoLeak(await page.content(), [A_TELEGRAM, A_PHONE, B_PHONE], 'A’s mutual cabinet');
    const drawerAAfter = await drawer(page, introId);
    expect(drawerAAfter.body.revealed, 'A sees B’s telegram, and nothing else').toEqual([
      { kind: 'telegram_username', value: B_TELEGRAM },
    ]);
    console.log(`[walkthrough] A: mutual, reveal = ${JSON.stringify(drawerAAfter.body.revealed)}`);

    // ── The same values are nowhere else: a stranger's card ──────────────────
    const anon = await browser.newContext({ viewport: MOBILE });
    contexts.push(anon);
    const visitor = await anon.newPage();
    await visitor.goto(cardUrl);
    await waitHydrated(visitor);
    await expect(visitor.getByTestId('pubcard-name')).toHaveText(A_NAME);
    expectNoLeak(await visitor.content(), [A_TELEGRAM, A_PHONE], 'A’s public card seen by a stranger');
    // Both of A's contacts are private, so the card publishes none of them.
    await expect(visitor.getByTestId('pubcard-links')).toHaveCount(0);
    await expect(visitor.getByText(en['pubcard.contactsEmpty'])).toBeVisible();
    // And a stranger is offered no way into the introduction.
    await expect(visitor.getByTestId('pubcard-signin-cta')).toBeVisible();
    await expect(visitor.getByTestId('pubcard-intro-cta')).toHaveCount(0);
    // The card still carries the QR (the artefact this whole journey starts from).
    await visitor.getByTestId('pubcard-qr').click();
    await expect(visitor.getByTestId('pubcard-qr-image')).toHaveAttribute('src', qrPath);
    expect(servedQrBitmap(await (await visitor.request.get(qrPath)).text()), 'the card’s QR is the same code').toBe(served);

    console.log(
      `[walkthrough] done: A + B mutual on ${introId}; revealed telegram only; `
        + `private values (${A_TELEGRAM}, ${A_PHONE}, ${B_PHONE}) verified absent from every page that must not carry them`,
    );
  } finally {
    for (const context of contexts) await context.close();
  }
});

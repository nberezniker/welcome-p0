import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
// tsx compiles page.tsx JSX with the classic transform — provide the React global
(globalThis as unknown as { React: unknown }).React = React;
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as importsRoute } from '../../src/app/api/events/[eventIdOrSlug]/imports/route';
import { POST as badgeLinksRoute } from '../../src/app/api/organizer/events/[eventId]/badge-links/route';
import { getSql, closeSql } from '../../src/lib/db';
import { loadBadgeSheet } from '../../src/lib/badges';
import { BadgeSheet } from '../../src/app/organizer/events/[eventId]/badges/badge-sheet';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

/**
 * Per-event QR badge sheet (AC: printable A4 sheet) and the claim-link batch
 * behind it. The sheet is a projection test as much as a render test: names and
 * QR targets must be present, emails and phones must be absent.
 */

after(async () => {
  await closeSql();
});

const BASE = 'https://welcome.test';
const A_GUEST_EMAIL = 'guest.petrov@example.org';

async function login(prefix: string): Promise<{ cookie: string; accountId: string }> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', { body: { display_name: `User ${prefix}` }, cookie }),
  );
  assertStatus(res, 200);
  return { cookie, accountId };
}

async function createEvent(cookie: string, slug: string): Promise<{ id: string; slug: string }> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'Badge Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC', slug },
      cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string; slug: string } }).event;
}

async function importGuests(cookie: string, eventId: string, csv: string): Promise<void> {
  const res = await importsRoute(
    makeRequest(`/api/events/${eventId}/imports`, { body: { csv_text: csv, mode: 'commit' }, cookie }),
    { params: Promise.resolve({ eventIdOrSlug: eventId }) },
  );
  assertStatus(res, 200);
}

async function issueBadgeLinks(cookie: string, eventId: string): Promise<Response> {
  return badgeLinksRoute(makeRequest(`/api/organizer/events/${eventId}/badge-links`, { method: 'POST', cookie }), {
    params: Promise.resolve({ eventId }),
  });
}

/** Two importable guests: one normal, one that will be quarantined. */
const GUEST_CSV = [
  'name,email,external_id,approval_status',
  `Anna Petrova,${A_GUEST_EMAIL},g-1,approved`,
  'Quarantined Person,quarantine.person@example.org,g-2,maybe',
].join('\n');

test('badges: the sheet carries names and QR targets, never emails or phones', async () => {
  const { cookie } = await login('badge-owner');
  const event = await createEvent(cookie, 'badge-sheet');
  await importGuests(cookie, event.id, GUEST_CSV);

  const sql = getSql();
  const data = await loadBadgeSheet(sql, event.id, BASE, 'Guest');
  assert.ok(data, 'the sheet must load for an existing event');

  // The approved guest is on the sheet, the quarantined one is not.
  assert.equal(data.cards.length, 1);
  assert.equal(data.quarantined, 1);
  assert.equal(data.cards[0]!.name, 'Anna Petrova');
  // No card yet → the QR falls back to the public event page.
  assert.equal(data.cards[0]!.needsClaimLink, true);
  assert.equal(data.cards[0]!.qrUrl, `${BASE}/e/${event.slug}`);

  // The rendered sheet is what gets printed: names present, no PII anywhere.
  const html = renderToStaticMarkup(
    React.createElement(BadgeSheet, {
      eventId: event.id,
      cards: data.cards,
      perSheet: 8,
      strings: {
        title: 'QR badges',
        subtitle: 'sub',
        backLink: 'Back',
        print: 'Print',
        linksTitle: 'Claim links',
        linksHint: 'hint',
        generate: 'Issue',
        generating: 'Loading',
        downloadCsv: 'CSV',
        csvFilename: 'badges.csv',
        issuesLabel: 'Issued {n}',
        excluded: null,
        empty: 'empty',
        errorGeneric: 'err',
        errorNetwork: 'net',
        qrAltTemplate: 'QR code for {name}',
      },
    }),
  );

  assert.ok(html.includes('Anna Petrova'), 'the guest name must be on the sheet');
  assert.ok(html.includes(`data-qr-url="${BASE}/e/${event.slug}"`), 'the QR target must be in the markup');
  assert.ok(html.includes('data:image/svg+xml;base64,'), 'the QR itself is an inline data URL (no external asset)');
  assert.ok(html.includes('QR code for Anna Petrova'), 'the QR needs a describing alt text');

  // PII discipline: neither the imported email nor its fragments appear.
  assert.ok(!html.includes(A_GUEST_EMAIL), 'the badge sheet must not contain an email address');
  assert.ok(!html.includes('@example.org'), 'no email domain may leak into the sheet');
  assert.ok(!/phone|whatsapp/i.test(html), 'no phone/contact field may appear on the sheet');
  // The quarantined guest is not printed either.
  assert.ok(!html.includes('Quarantined Person'));
});

test('badges: a claimed guest\'s badge points at their card', async () => {
  const { cookie, accountId } = await login('badge-claimed');
  const event = await createEvent(cookie, 'badge-claimed');
  await importGuests(cookie, event.id, ['name,email,external_id', 'Card Holder,card.holder@example.org,g-1'].join('\n'));

  // Simulate the claim: profile + membership bound to the registration.
  const sql = getSql();
  const profileRows = await sql<{ id: string; public_slug: string }[]>`
    SELECT id, public_slug FROM profiles WHERE account_id = ${accountId} LIMIT 1
  `;
  const profile = profileRows[0]!;
  const regRows = await sql<{ id: string }[]>`
    SELECT id FROM registrations WHERE event_id = ${event.id}::uuid LIMIT 1
  `;
  await sql`
    INSERT INTO event_memberships (event_id, profile_id, registration_id, state)
    VALUES (${event.id}::uuid, ${profile.id}::uuid, ${regRows[0]!.id}::uuid, 'active')
  `;
  await sql`UPDATE registrations SET claim_state = 'claimed' WHERE id = ${regRows[0]!.id}::uuid`;

  const data = await loadBadgeSheet(sql, event.id, BASE, 'Guest');
  assert.ok(data);
  assert.equal(data.cards.length, 1);
  assert.equal(data.cards[0]!.needsClaimLink, false, 'a claimed guest has a card, so no claim link is needed');
  assert.equal(data.cards[0]!.qrUrl, `${BASE}/p/${profile.public_slug}`);
});

test('badges: claim links are issued for unclaimed guests, quarantined ones excluded', async () => {
  const { cookie } = await login('badge-links');
  const event = await createEvent(cookie, 'badge-links-event');
  await importGuests(cookie, event.id, GUEST_CSV);

  const res = await issueBadgeLinks(cookie, event.id);
  assertStatus(res, 200);
  const body = (await res.json()) as {
    issued: number;
    links: { registration_id: string; name: string | null; claim_url: string; qr_data_url: string }[];
    csv: string;
  };

  // One approved+unclaimed guest; the quarantined one gets nothing.
  assert.equal(body.issued, 1);
  assert.equal(body.links.length, 1);
  assert.equal(body.links[0]!.name, 'Anna Petrova');
  assert.ok(body.links[0]!.claim_url.includes('/claim/'), 'the link must be a claim URL');
  assert.ok(body.links[0]!.qr_data_url.startsWith('data:image/svg+xml'), 'the QR is an inline SVG data URL');

  // The one-time token is stored ONLY as a hash.
  const sql = getSql();
  const token = body.links[0]!.claim_url.split('/claim/')[1]!;
  const stored = await sql<{ token_hash: string | null }[]>`
    SELECT token_hash FROM link_challenges WHERE registration_id = ${body.links[0]!.registration_id}::uuid
    LIMIT 1
  `;
  assert.ok(stored[0], 'a challenge row must exist');
  assert.notEqual(stored[0]!.token_hash, token, 'the raw token must never be stored');

  // The CSV has no PII: an opaque id and a URL, nothing else.
  assert.match(body.csv, /^registration_id,claim_url\r\n/);
  assert.ok(!body.csv.includes(A_GUEST_EMAIL), 'the CSV must not contain an email');
  assert.ok(!body.csv.includes('Anna Petrova'), 'the CSV must not contain a name');
  assert.ok(body.csv.includes('/claim/'), 'the CSV must contain the claim URLs');
});

test('badges: re-issuing refreshes the links (each batch is a fresh token)', async () => {
  const { cookie } = await login('badge-reissue');
  const event = await createEvent(cookie, 'badge-reissue');
  await importGuests(cookie, event.id, ['name,email,external_id', 'Link Guest,link.guest@example.org,g-1'].join('\n'));

  const first = (await (await issueBadgeLinks(cookie, event.id)).json()) as { links: { claim_url: string }[] };
  const second = (await (await issueBadgeLinks(cookie, event.id)).json()) as { links: { claim_url: string }[] };
  assert.equal(first.links.length, 1);
  assert.equal(second.links.length, 1);
  assert.notEqual(first.links[0]!.claim_url, second.links[0]!.claim_url, 'a new batch mints new tokens');
});

test('badges: a stranger cannot see the sheet or issue links', async () => {
  const owner = await login('badge-owner-403');
  const event = await createEvent(owner.cookie, 'badge-403');
  await importGuests(owner.cookie, event.id, ['name,email,external_id', 'Some Guest,some.guest@example.org,g-1'].join('\n'));

  const stranger = await login('badge-stranger');

  const res = await issueBadgeLinks(stranger.cookie, event.id);
  assertStatus(res, 403);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'forbidden');

  // No claim link was minted by the refused attempt.
  const sql = getSql();
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM link_challenges lc
    JOIN registrations r ON r.id = lc.registration_id
    WHERE r.event_id = ${event.id}::uuid
  `;
  assert.equal(rows[0]!.count, 0);
});

test('badges: staff are not allowed — the sheet is owner/admin only', async () => {
  const owner = await login('badge-owner-staff');
  const event = await createEvent(owner.cookie, 'badge-staff');

  const staff = await login('badge-staff');
  const sql = getSql();
  const orgRows = await sql<{ organizer_id: string }[]>`
    SELECT organizer_id FROM events WHERE id = ${event.id}::uuid LIMIT 1
  `;
  await sql`
    INSERT INTO organizer_members (organizer_id, account_id, role)
    VALUES (${orgRows[0]!.organizer_id}::uuid, ${staff.accountId}::uuid, 'staff')
  `;

  const res = await issueBadgeLinks(staff.cookie, event.id);
  assertStatus(res, 403);
});

test('badges: an anonymous request is refused', async () => {
  const owner = await login('badge-owner-anon');
  const event = await createEvent(owner.cookie, 'badge-anon');

  const res = await badgeLinksRoute(
    makeRequest(`/api/organizer/events/${event.id}/badge-links`, { method: 'POST' }),
    { params: Promise.resolve({ eventId: event.id }) },
  );
  assertStatus(res, 401);
});

test('badges: an unknown event is a 404 for the organizer route', async () => {
  const { cookie } = await login('badge-missing');
  const missing = '11111111-1111-1111-1111-111111111111';
  const res = await issueBadgeLinks(cookie, missing);
  // No role on a non-existent event ⇒ 403 from the role check (the role gate
  // runs before the event lookup, so existence is never disclosed).
  assertStatus(res, 403);

  const sql = getSql();
  assert.equal(await loadBadgeSheet(sql, missing, BASE, 'Guest'), null);
});

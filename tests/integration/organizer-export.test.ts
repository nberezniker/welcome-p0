import test from 'node:test';
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { POST as createIntroRoute } from '../../src/app/api/introductions/route';
import { POST as respondIntroRoute } from '../../src/app/api/introductions/[id]/respond/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { GET as exportRoute } from '../../src/app/api/organizer/events/[eventId]/export/route';
import { getSql, closeSql } from '../../src/lib/db';
import { emailLookupHash } from '../../src/lib/crypto';
import { requireHashPepper } from '../../src/lib/env';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

/** Phase 5 organizer export (GET /api/organizer/events/[eventId]/export):
 * owner/admin only, event-scoped CSV, formula neutralization on every cell. */

after(async () => {
  await closeSql();
});

const sql = getSql();

interface Actor {
  cookie: string;
  accountId: string;
  profileId: string;
}

async function login(prefix: string, displayName: string): Promise<Actor> {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail(prefix));
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: displayName, languages: ['en'], offer_tags: [], need_tags: [] },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { cookie, accountId, profileId: rows[0]!.id };
}

let owner: Actor;
let member: Actor;
let formulaMember: Actor;
let eventId: string;
let eventSlug: string;

before(async () => {
  owner = await login('exp-owner', 'Export Owner');
  member = await login('exp-member', 'Regular Member');
  // CSV/spreadsheet formula payload as a member display name.
  formulaMember = await login('exp-formula', '=HYPERLINK("http://evil";"x")');

  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'Export Meetup', slug: 'export-meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(res, 201);
  const event = ((await res.json()) as { event: { id: string; slug: string } }).event;
  eventId = event.id;
  eventSlug = event.slug;

  await joinRoute(makeRequest(`/api/events/${eventId}/join`, { body: {}, cookie: member.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: eventId }),
  });
  await joinRoute(makeRequest(`/api/events/${eventId}/join`, { body: {}, cookie: formulaMember.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: eventId }),
  });
  // Opt both into the directory.
  await sql`UPDATE event_memberships SET directory_visible = true WHERE event_id = ${eventId}`;
});

test('export: owner gets CSV with event-scoped sections, comment header, event-slug filename', async () => {
  const res = await exportRoute(makeRequest(`/api/organizer/events/${eventId}/export`, { cookie: owner.cookie }), {
    params: Promise.resolve({ eventId }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="${eventSlug}.csv"`);

  const text = await res.text();
  assert.ok(text.startsWith('# WELCOME event export'), 'must start with the scope comment header');
  assert.ok(text.includes('no emails'), 'header comment must state the scope limitation');
  assert.ok(text.includes('# section: registrations'));
  assert.ok(text.includes('# section: directory_members'));
  assert.ok(text.includes('# section: intro_counts'));
});

test('export: CSV formula injection neutralized — "=HYPERLINK(...)" appears with leading apostrophe', async () => {
  const res = await exportRoute(makeRequest(`/api/organizer/events/${eventId}/export`, { cookie: owner.cookie }), {
    params: Promise.resolve({ eventId }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();

  // Neutralized name is RFC4180-quoted (it contains quotes): "…'=HYPERLINK(""http://evil"";""x"")"
  const occurrences = text.split("'=HYPERLINK").length - 1;
  assert.equal(occurrences, 2, 'formula name must be neutralized in directory_members AND intro_counts');
  assert.ok(!/[,\r\n]=HYPERLINK/.test(text), 'no un-neutralized formula may start a CSV cell');
});

test('export: no emails, no lookup hashes, no private contact values in the payload', async () => {
  const regEmail = 'export-reg-secret@integration.test';
  const hash = emailLookupHash(regEmail, requireHashPepper());
  await sql`
    INSERT INTO registrations (event_id, imported_name, email_lookup_hash, claim_state, approval_status)
    VALUES (${eventId}, 'Imported Person', ${hash}, 'unclaimed', 'approved')
  `;

  const res = await exportRoute(makeRequest(`/api/organizer/events/${eventId}/export`, { cookie: owner.cookie }), {
    params: Promise.resolve({ eventId }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();

  assert.ok(text.includes('Imported Person,unclaimed,approved'), 'registration row must carry only name/state/status');
  assert.ok(!text.includes(hash), 'email lookup hash must never be exported');
  assert.ok(!text.includes(regEmail));
  assert.ok(!text.toLowerCase().includes('email_lookup'), 'no email columns in the export');
});

test('export: intro counts are aggregates only (requested/mutual per member, no pair identities)', async () => {
  const introRes = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: formulaMember.profileId, event_id: eventId },
      cookie: member.cookie,
    }),
  );
  assertStatus(introRes, 200);
  const introId = ((await introRes.json()) as { introduction: { id: string } }).introduction.id;
  await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, { body: { decision: 'accept' }, cookie: formulaMember.cookie }),
    { params: Promise.resolve({ id: introId }) },
  );
  await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, { body: { decision: 'accept' }, cookie: member.cookie }),
    { params: Promise.resolve({ id: introId }) },
  );

  const res = await exportRoute(makeRequest(`/api/organizer/events/${eventId}/export`, { cookie: owner.cookie }), {
    params: Promise.resolve({ eventId }),
  });
  const text = await res.text();
  assert.ok(text.includes('Regular Member,1,1'), 'mutual intro must be counted once requested/once mutual');
  assert.ok(!text.includes(introId), 'introduction id (pair identity) must not appear');
});

test('export: staff of the same organizer is forbidden (owner/admin only)', async () => {
  const staff = await login('exp-staff', 'Export Staff');
  const organizerRows = await sql<{ organizer_id: string }[]>`SELECT organizer_id FROM events WHERE id = ${eventId}`;
  await sql`
    INSERT INTO organizer_members (organizer_id, account_id, role)
    VALUES (${organizerRows[0]!.organizer_id}, ${staff.accountId}, 'staff')
  `;
  const res = await exportRoute(makeRequest(`/api/organizer/events/${eventId}/export`, { cookie: staff.cookie }), {
    params: Promise.resolve({ eventId }),
  });
  assert.equal(res.status, 403);
});

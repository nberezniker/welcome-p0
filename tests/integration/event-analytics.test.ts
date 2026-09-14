import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { POST as createIntroRoute } from '../../src/app/api/introductions/route';
import { POST as respondIntroRoute } from '../../src/app/api/introductions/[id]/respond/route';
import { PUT as putNoteRoute } from '../../src/app/api/me/notes/[otherProfileId]/route';
import { POST as attendanceRoute } from '../../src/app/api/me/memberships/[membershipId]/attendance/route';
import { GET as analyticsRoute } from '../../src/app/api/organizer/events/[eventId]/analytics/route';
import { getSql, closeSql } from '../../src/lib/db';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

/**
 * GET /api/organizer/events/[eventId]/analytics — funnel aggregates.
 *
 * The numbers are asserted against a fixture built through the REAL routes
 * (join → intro → respond → note → attendance), so the aggregate definitions are
 * checked against rows the product itself wrote, not against hand-inserted rows.
 * Access control is asserted separately: owner/admin yes, staff/stranger/no-session no.
 */

after(async () => {
  await closeSql();
});

const sql = getSql();

interface Actor {
  cookie: string;
  accountId: string;
  profileId: string;
}

async function login(prefix: string): Promise<Actor> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `Analytics ${prefix}`, languages: ['en'], offer_tags: [], need_tags: [] },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { cookie, accountId, profileId: rows[0]!.id };
}

async function createEvent(owner: Actor, name = 'Analytics Meetup'): Promise<string> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name, mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string } }).event.id;
}

async function addMember(eventId: string, member: Actor, opts: { visible?: boolean } = {}): Promise<string> {
  const res = await joinRoute(
    makeRequest(`/api/events/${eventId}/join`, { body: {}, cookie: member.cookie }),
    { params: Promise.resolve({ eventIdOrSlug: eventId }) },
  );
  assertStatus(res, 200);
  if (opts.visible) {
    await sql`UPDATE event_memberships SET directory_visible = true WHERE event_id = ${eventId} AND profile_id = ${member.profileId}`;
  }
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM event_memberships WHERE event_id = ${eventId} AND profile_id = ${member.profileId}
  `;
  return rows[0]!.id;
}

async function analyticsOf(eventId: string, actor: Actor): Promise<Response> {
  return analyticsRoute(makeRequest(`/api/organizer/events/${eventId}/analytics`, { cookie: actor.cookie }), {
    params: Promise.resolve({ eventId }),
  });
}

test('analytics: aggregates are counted for the event and for that event only', async () => {
  const owner = await login('an-owner');
  const a = await login('an-a');
  const b = await login('an-b');
  const c = await login('an-c');
  const eventId = await createEvent(owner);
  const membershipA = await addMember(eventId, a, { visible: true });
  await addMember(eventId, b, { visible: true });
  await addMember(eventId, c); // joined but NOT directory-visible

  // Noise that must NOT leak into this event's aggregates.
  const otherOwner = await login('an-other');
  const otherEventId = await createEvent(otherOwner, 'Analytics Other Event');
  const outsider = await login('an-outsider');
  await addMember(otherEventId, outsider, { visible: true });

  // Registrations: two imported, one claimed.
  await sql`
    INSERT INTO registrations (event_id, provider, external_guest_id, email_lookup_hash, imported_name, claim_state)
    VALUES (${eventId}, 'csv', ${'an-' + randomUUID()}, ${'hash-' + randomUUID()}, 'Guest One', 'unclaimed'),
           (${eventId}, 'csv', ${'an-' + randomUUID()}, ${'hash-' + randomUUID()}, 'Guest Two', 'claimed')
  `;

  // a → b: mutual with an intersecting reveal field.
  const mutualCreate = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: b.profileId, event_id: eventId, reveal_fields: ['whatsapp'] },
      cookie: a.cookie,
    }),
  );
  assertStatus(mutualCreate, 200);
  const mutualId = ((await mutualCreate.json()) as { introduction: { id: string } }).introduction.id;
  assertStatus(
    await respondIntroRoute(
      makeRequest(`/api/introductions/${mutualId}/respond`, {
        body: { decision: 'accept', reveal_fields: ['whatsapp'] },
        cookie: b.cookie,
      }),
      { params: Promise.resolve({ id: mutualId }) },
    ),
    200,
  );

  // a → c: declined.
  const declinedCreate = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: c.profileId, event_id: eventId },
      cookie: a.cookie,
    }),
  );
  assertStatus(declinedCreate, 200);
  const declinedId = ((await declinedCreate.json()) as { introduction: { id: string } }).introduction.id;
  assertStatus(
    await respondIntroRoute(
      makeRequest(`/api/introductions/${declinedId}/respond`, { body: { decision: 'decline' }, cookie: c.cookie }),
      { params: Promise.resolve({ id: declinedId }) },
    ),
    200,
  );

  // An introduction in ANOTHER event — must not be counted here.
  await addMember(otherEventId, otherOwner);
  const otherPair = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: outsider.profileId, event_id: otherEventId },
      cookie: otherOwner.cookie,
    }),
  );
  assertStatus(otherPair, 200);

  // One note by a member about another member + one self-reported attendance.
  assertStatus(
    await putNoteRoute(
      makeRequest(`/api/me/notes/${b.profileId}`, { body: { note_text: 'met at the mixer' }, cookie: a.cookie }),
      { params: Promise.resolve({ otherProfileId: b.profileId }) },
    ),
    200,
  );
  assertStatus(
    await attendanceRoute(
      makeRequest(`/api/me/memberships/${membershipA}/attendance`, { body: { present: true }, cookie: a.cookie }),
      { params: Promise.resolve({ membershipId: membershipA }) },
    ),
    200,
  );

  const res = await analyticsOf(eventId, owner);
  assertStatus(res, 200);
  const body = (await res.json()) as {
    analytics: Record<string, unknown>;
    note: string;
    event_id: string;
  };
  const analytics = body.analytics as unknown as Record<string, number> & {
    by_day: { date: string; registrations: number; intros: number; mutual: number }[];
  };
  assert.equal(body.event_id, eventId);
  assert.match(body.note, /no private content/i);

  assert.equal(analytics['registrations_total'], 2);
  assert.equal(analytics['registrations_claimed'], 1);
  assert.equal(analytics['members_active'], 3, 'the organizer is not a member of its own event');
  assert.equal(analytics['members_directory_visible'], 2);
  assert.equal(analytics['intros_requested'], 2, 'the other event’s introduction is not counted');
  assert.equal(analytics['intros_mutual'], 1);
  assert.equal(analytics['intros_declined'], 1);
  assert.equal(analytics['reveals_total'], 1, 'mutual with an intersecting reveal field');
  assert.equal(analytics['notes_created'], 1);
  assert.equal(analytics['attendance_self_reported'], 1);

  // by_day: 30 calendar days, oldest first, summing to the event totals.
  const { today } = (
    await sql<{ today: string }[]>`SELECT to_char(current_date, 'YYYY-MM-DD') AS today`
  )[0]!;
  assert.equal(analytics.by_day.length, 30);
  assert.equal(analytics.by_day[29]!.date, today, 'the series ends today');
  assert.equal(analytics.by_day[0]!.date < today, true, 'the series starts 29 days earlier');
  const sum = (key: 'registrations' | 'intros' | 'mutual') =>
    analytics.by_day.reduce((n, d) => n + d[key], 0);
  assert.equal(sum('registrations'), analytics['registrations_total']);
  assert.equal(sum('intros'), analytics['intros_requested']);
  assert.equal(sum('mutual'), analytics['intros_mutual']);
  assert.equal(analytics.by_day[29]!.registrations, 2, 'both imported registrations happened today');

  // PII-free by construction: only counts and dates.
  const serialized = JSON.stringify(analytics);
  for (const leak of ['Guest One', 'Guest Two', 'Analytics an-a', 'met at the mixer', 'hash-']) {
    assert.equal(serialized.includes(leak), false, `analytics must not contain "${leak}"`);
  }
});

test('analytics: staff and strangers get 403, anonymous gets 401', async () => {
  const owner = await login('an-auth-owner');
  const staff = await login('an-auth-staff');
  const stranger = await login('an-auth-stranger');
  const eventId = await createEvent(owner);
  await sql`
    INSERT INTO organizer_members (organizer_id, account_id, role)
    SELECT e.organizer_id, ${staff.accountId}, 'staff' FROM events e WHERE e.id = ${eventId}
  `;

  assertStatus(await analyticsOf(eventId, staff), 403);
  assertStatus(await analyticsOf(eventId, stranger), 403);

  // Unknown event: still 403 — the endpoint never confirms which events exist.
  assertStatus(await analyticsOf(randomUUID(), owner), 403);

  const anon = await analyticsRoute(makeRequest(`/api/organizer/events/${eventId}/analytics`), {
    params: Promise.resolve({ eventId }),
  });
  assertStatus(anon, 401);
});

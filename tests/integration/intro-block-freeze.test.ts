import test from 'node:test';
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { POST as createIntroRoute } from '../../src/app/api/introductions/route';
import { POST as respondIntroRoute } from '../../src/app/api/introductions/[id]/respond/route';
import { GET as introViewRoute } from '../../src/app/api/introductions/[id]/route';
import { PUT as putContactRoute } from '../../src/app/api/me/contacts/route';
import { POST as blocksRoute } from '../../src/app/api/blocks/route';
import { getSql, closeSql } from '../../src/lib/db';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

/** Regression for the Phase-5 security-review fix (SECURITY_TESTS #11):
 * a block between the parties (either direction) freezes introductions —
 * no new state transition and no (new) contact reveal. */

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
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail(prefix));
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `Freeze ${prefix}`, languages: ['en'], offer_tags: [], need_tags: [] },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { cookie, accountId, profileId: rows[0]!.id };
}

let alice: Actor;
let bob: Actor;
let carol: Actor;
let eventId: string;
let introId: string;

before(async () => {
  alice = await login('alice');
  bob = await login('bob');
  carol = await login('carol');

  const ev = await (await import('../../src/app/api/organizer/events/route')).POST(
    makeRequest('/api/organizer/events', {
      body: { name: 'Freeze Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie: alice.cookie,
    }),
  );
  assertStatus(ev, 201);
  eventId = ((await ev.json()) as { event: { id: string } }).event.id;
  for (const actor of [alice, bob, carol]) {
    await joinRoute(makeRequest(`/api/events/${eventId}/join`, { body: {}, cookie: actor.cookie }), {
      params: Promise.resolve({ eventIdOrSlug: eventId }),
    });
  }

  // Contacts for both sides so a reveal would carry values.
  for (const actor of [alice, bob]) {
    await putContactRoute(
      makeRequest('/api/me/contacts', {
        method: 'PUT',
        body: { kind: 'telegram_username', value: '@freeze-' + actor.profileId.slice(0, 5), public_enabled: true },
        cookie: actor.cookie,
      }),
    ).then((r) => assertStatus(r, 200));
  }

  const intro = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: bob.profileId, event_id: eventId },
      cookie: alice.cookie,
    }),
  );
  assertStatus(intro, 200);
  introId = ((await intro.json()) as { introduction: { id: string } }).introduction.id;

  // Alice accepts while relations are still friendly.
  await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, { body: { decision: 'accept', reveal_fields: ['telegram_username'] }, cookie: alice.cookie }),
    { params: Promise.resolve({ id: introId }) },
  ).then((r) => assertStatus(r, 200));
});

test('block after intro request: responder is rejected with 403 blocked, state stays pending', async () => {
  // Bob blocks Alice, then tries to accept the pending intro.
  await blocksRoute(
    makeRequest('/api/blocks', { body: { target_account_id: alice.accountId }, cookie: bob.cookie }),
  ).then((r) => assertStatus(r, 200));

  const res = await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, { body: { decision: 'accept', reveal_fields: ['telegram_username'] }, cookie: bob.cookie }),
    { params: Promise.resolve({ id: introId }) },
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'blocked');

  const state = await sql<{ state: string }[]>`SELECT state FROM introductions WHERE id = ${introId}`;
  assert.equal(state[0]!.state, 'pending', 'no mutual transition may happen across a block');
});

test('block after intro request: the blocker is also frozen (symmetric)', async () => {
  // Alice (the blocker's counterpart) cannot respond either — either direction freezes.
  const res = await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, { body: { decision: 'withdraw' }, cookie: alice.cookie }),
    { params: Promise.resolve({ id: introId }) },
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'blocked');
});

test('unblocking restores the ability to respond', async () => {
  await sql`DELETE FROM blocks WHERE blocker_account_id = ${bob.accountId} AND target_account_id = ${alice.accountId}`;
  const res = await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, { body: { decision: 'accept', reveal_fields: ['telegram_username'] }, cookie: bob.cookie }),
    { params: Promise.resolve({ id: introId }) },
  );
  assertStatus(res, 200);
  const state = await sql<{ state: string }[]>`SELECT state FROM introductions WHERE id = ${introId}`;
  assert.equal(state[0]!.state, 'mutual');
});

test('block after mutual: reveal is suppressed for BOTH parties while the block stands', async () => {
  // Sanity: reveal worked before the block.
  const before = await introViewRoute(makeRequest(`/api/introductions/${introId}`, { cookie: alice.cookie }), {
    params: Promise.resolve({ id: introId }),
  });
  assertStatus(before, 200);
  const beforeBody = (await before.json()) as { revealed: unknown[] };
  assert.ok(beforeBody.revealed.length > 0, 'mutual reveal must carry contact values pre-block');

  // Alice blocks Bob — both directions must now see an empty reveal.
  await blocksRoute(
    makeRequest('/api/blocks', { body: { target_account_id: bob.accountId }, cookie: alice.cookie }),
  ).then((r) => assertStatus(r, 200));

  for (const actor of [alice, bob]) {
    const res = await introViewRoute(makeRequest(`/api/introductions/${introId}`, { cookie: actor.cookie }), {
      params: Promise.resolve({ id: introId }),
    });
    assertStatus(res, 200);
    const body = (await res.json()) as { revealed: unknown[] };
    assert.deepEqual(body.revealed, [], `reveal must be empty for ${actor === alice ? 'alice' : 'bob'} under a block`);
  }
});

test('control: an unrelated third party still gets 404 on the intro view', async () => {
  const res = await introViewRoute(makeRequest(`/api/introductions/${introId}`, { cookie: carol.cookie }), {
    params: Promise.resolve({ id: introId }),
  });
  assert.equal(res.status, 404);
});

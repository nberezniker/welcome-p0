import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { PUT as contactsRoute } from '../../src/app/api/me/contacts/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { PATCH as membershipPatchRoute } from '../../src/app/api/me/memberships/[membershipId]/route';
import { GET as recommendationsRoute } from '../../src/app/api/events/[eventIdOrSlug]/recommendations/route';
import { POST as createIntroRoute } from '../../src/app/api/introductions/route';
import { POST as respondRoute } from '../../src/app/api/introductions/[id]/respond/route';
import { GET as getIntroRoute } from '../../src/app/api/introductions/[id]/route';
import { getSql, closeSql } from '../../src/lib/db';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

after(async () => {
  await closeSql();
});

interface User {
  cookie: string;
  accountId: string;
  profileId: string;
}

async function login(prefix: string, tags: { offers?: string[]; needs?: string[] } = {}): Promise<User> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `Intro ${prefix}`, languages: ['en'], offer_tags: tags.offers ?? [], need_tags: tags.needs ?? [] },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { cookie, accountId, profileId: rows[0]!.id };
}

async function setupEventPair(prefix: string): Promise<{ eventId: string; a: User; b: User }> {
  const { cookie: orgCookie } = await login(prefix + '-org');
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'Intro Meetup ' + prefix, mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie: orgCookie,
    }),
  );
  assertStatus(res, 201);
  const { id: eventId } = ((await res.json()) as { event: { id: string } }).event;
  const a = await login(prefix + '-a', { offers: ['mentoring'], needs: ['frontend'] });
  const b = await login(prefix + '-b', { offers: ['frontend'], needs: ['mentoring'] });
  for (const u of [a, b]) {
    const j = await joinRoute(makeRequest(`/api/events/${eventId}/join`, { body: {}, cookie: u.cookie }), {
      params: Promise.resolve({ eventIdOrSlug: eventId }),
    });
    assertStatus(j, 200);
    const sql = getSql();
    const mids = await sql<{ id: string }[]>`SELECT id FROM event_memberships WHERE profile_id = ${u.profileId} AND event_id = ${eventId}`;
    const mid = mids[0]!.id;
    const opt = await membershipPatchRoute(
      makeRequest(`/api/me/memberships/${mid}`, { body: { directory_visible: true }, cookie: u.cookie }),
      { params: Promise.resolve({ membershipId: mid }) },
    );
    assertStatus(opt, 200);
  }
  return { eventId, a, b };
}

function createIntro(user: User, body: Record<string, unknown>): Promise<Response> {
  return createIntroRoute(makeRequest('/api/introductions', { body, cookie: user.cookie }));
}

function respond(user: User, introId: string, body: Record<string, unknown>): Promise<Response> {
  return respondRoute(makeRequest(`/api/introductions/${introId}/respond`, { body, cookie: user.cookie }), {
    params: Promise.resolve({ id: introId }),
  });
}

async function getIntro(user: User, introId: string): Promise<Response> {
  return getIntroRoute(makeRequest(`/api/introductions/${introId}`, { cookie: user.cookie }), {
    params: Promise.resolve({ id: introId }),
  });
}

test('introductions: create is idempotent, canonical pair, initiator from session (AC-33)', async () => {
  const { eventId, a, b } = await setupEventPair('t1');

  const res = await createIntro(a, {
    target_profile_id: b.profileId,
    event_id: eventId,
    reveal_fields: ['whatsapp'],
    initiator_profile_id: b.profileId, // spoof attempt — must be ignored
  });
  assertStatus(res, 200);
  const body = (await res.json()) as {
    introduction: { id: string; state: string; profile_a: string; profile_b: string; context_key: string };
    already_existed: boolean;
  };
  assert.equal(body.introduction.state, 'pending');
  assert.equal(body.already_existed, false);
  const pair = [body.introduction.profile_a, body.introduction.profile_b].sort();
  assert.deepEqual(pair, [a.profileId, b.profileId].sort());
  assert.equal(body.introduction.context_key, `event:${eventId}`);

  // Initiator is the SESSION user, not the spoofed body value.
  const sql = getSql();
  const consentRows = await sql<{ profile_id: string; decision: string; reveal_fields: string[]; version: number }[]>`
    SELECT profile_id, decision, reveal_fields, version::int AS version
    FROM introduction_consents WHERE introduction_id = ${body.introduction.id}
  `;
  assert.equal(consentRows.length, 1);
  assert.equal(consentRows[0]?.profile_id, a.profileId);
  assert.equal(consentRows[0]?.decision, 'pending');
  assert.deepEqual(consentRows[0]?.reveal_fields, ['whatsapp']);

  // Idempotent re-create returns the same introduction.
  const again = await createIntro(a, { target_profile_id: b.profileId, event_id: eventId, reveal_fields: ['whatsapp'] });
  assertStatus(again, 200);
  const againBody = (await again.json()) as { introduction: { id: string }; already_existed: boolean };
  assert.equal(againBody.introduction.id, body.introduction.id);
  assert.equal(againBody.already_existed, true);

  const count = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM introductions WHERE id = ${body.introduction.id}`;
  assert.equal(count[0]?.count, 1);
});

test('introductions: self-intro 400; unknown target 404; anonymous 401', async () => {
  const { eventId, a } = await setupEventPair('t2');

  const self = await createIntro(a, { target_profile_id: a.profileId, event_id: eventId });
  assertStatus(self, 400);

  const ghost = await createIntro(a, { target_profile_id: 'c0000000-0000-4000-8000-000000000009', event_id: eventId });
  assertStatus(ghost, 404);

  const anon = await createIntroRoute(makeRequest('/api/introductions', { body: { target_profile_id: a.profileId } }));
  assertStatus(anon, 401);
});

test('introductions: AC-31 — one-sided accept reveals NOTHING', async () => {
  const { eventId, a, b } = await setupEventPair('t3');
  const created = await createIntro(a, { target_profile_id: b.profileId, event_id: eventId, reveal_fields: ['whatsapp'] });
  const introId = ((await created.json()) as { introduction: { id: string } }).introduction.id;

  const bAccept = await respond(b, introId, { decision: 'accept', reveal_fields: ['phone'] });
  assertStatus(bAccept, 200);

  const forA = await getIntro(a, introId);
  const aBody = (await forA.json()) as { introduction: { state: string; other_accepted: boolean; my_decision: string }; revealed: unknown[] };
  assert.equal(aBody.introduction.state, 'pending');
  assert.equal(aBody.introduction.other_accepted, true);
  assert.equal(aBody.introduction.my_decision, 'pending');
  assert.deepEqual(aBody.revealed, [], 'one-sided accept must not reveal anything');

  const forB = await getIntro(b, introId);
  const bBody = (await forB.json()) as { introduction: { state: string }; revealed: unknown[] };
  assert.deepEqual(bBody.revealed, []);
});

test('introductions: AC-32 — concurrent double accept: both 200, one mutual transition, one audit', async () => {
  const { eventId, a, b } = await setupEventPair('t4');
  const created = await createIntro(a, { target_profile_id: b.profileId, event_id: eventId, reveal_fields: ['whatsapp'] });
  const introId = ((await created.json()) as { introduction: { id: string } }).introduction.id;

  const [resA, resB] = await Promise.all([
    respond(a, introId, { decision: 'accept', reveal_fields: ['whatsapp'] }),
    respond(b, introId, { decision: 'accept', reveal_fields: ['whatsapp'] }),
  ]);
  assertStatus(resA, 200);
  assertStatus(resB, 200);

  const sql = getSql();
  const intro = await sql<{ state: string }[]>`SELECT state FROM introductions WHERE id = ${introId}`;
  assert.equal(intro[0]?.state, 'mutual');

  const audits = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM audit_events WHERE action = 'intro.mutual' AND target_id = ${introId}
  `;
  assert.equal(audits[0]?.count, 1, 'exactly one intro.mutual audit');
  void eventId;
});

test('introductions: AC-34 — empty reveal_fields intersection reveals nothing', async () => {
  const { eventId, a, b } = await setupEventPair('t5');
  const created = await createIntro(a, { target_profile_id: b.profileId, event_id: eventId, reveal_fields: ['whatsapp'] });
  const introId = ((await created.json()) as { introduction: { id: string } }).introduction.id;
  await respond(a, introId, { decision: 'accept', reveal_fields: ['whatsapp'] });
  await respond(b, introId, { decision: 'accept', reveal_fields: [] }); // empty consent

  const forA = await getIntro(a, introId);
  const body = (await forA.json()) as { introduction: { state: string }; revealed: unknown[] };
  assert.equal(body.introduction.state, 'mutual');
  assert.deepEqual(body.revealed, [], 'empty field consent → nothing revealed');
});

test('introductions: mutual reveal returns the OTHER side decrypted contact values', async () => {
  const { eventId, a, b } = await setupEventPair('t6');

  // Both add a WhatsApp contact (not public) to prove reveal uses consent, not public_enabled.
  const wa1 = await contactsRoute(
    makeRequest('/api/me/contacts', { method: 'PUT', body: { kind: 'whatsapp', value: '+34600111222', public_enabled: false }, cookie: a.cookie }),
  );
  assert.equal(wa1.status === 200 || wa1.status === 201, true);
  const wa2 = await contactsRoute(
    makeRequest('/api/me/contacts', { method: 'PUT', body: { kind: 'whatsapp', value: '+34600333444', public_enabled: false }, cookie: b.cookie }),
  );
  assert.equal(wa2.status === 200 || wa2.status === 201, true);

  const created = await createIntro(a, { target_profile_id: b.profileId, event_id: eventId, reveal_fields: ['whatsapp'] });
  const introId = ((await created.json()) as { introduction: { id: string } }).introduction.id;
  await respond(a, introId, { decision: 'accept', reveal_fields: ['whatsapp'] });
  await respond(b, introId, { decision: 'accept', reveal_fields: ['whatsapp'] });

  const forA = await getIntro(a, introId);
  const aBody = (await forA.json()) as { revealed: Array<{ kind: string; value: string }> };
  assert.deepEqual(aBody.revealed, [{ kind: 'whatsapp', value: '+34600333444' }]);

  const forB = await getIntro(b, introId);
  const bBody = (await forB.json()) as { revealed: Array<{ kind: string; value: string }> };
  assert.deepEqual(bBody.revealed, [{ kind: 'whatsapp', value: '+34600111222' }]);
});

test('introductions: decline is not exposed to the other side; pair excluded from recommendations', async () => {
  const { eventId, a, b } = await setupEventPair('t7');
  const created = await createIntro(a, { target_profile_id: b.profileId, event_id: eventId, reveal_fields: [] });
  const introId = ((await created.json()) as { introduction: { id: string } }).introduction.id;

  const decline = await respond(b, introId, { decision: 'decline' });
  assertStatus(decline, 200);

  const forB = await getIntro(b, introId);
  const bBody = (await forB.json()) as { introduction: { state: string; my_decision: string } };
  assert.equal(bBody.introduction.state, 'declined');
  assert.equal(bBody.introduction.my_decision, 'decline');

  // The requester never sees the refusal — it stays "pending" for them.
  const forA = await getIntro(a, introId);
  const aBody = (await forA.json()) as { introduction: { state: string; other_accepted: boolean } };
  assert.equal(aBody.introduction.state, 'pending');
  assert.equal(aBody.introduction.other_accepted, false);

  // Declined pair is excluded from recommendations within the cooldown window.
  const recs = await recommendationsRoute(makeRequest(`/api/events/${eventId}/recommendations`, { cookie: a.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: eventId }),
  });
  assert.deepEqual(((await recs.json()) as { recommendations: unknown[] }).recommendations, []);
});

test('introductions: withdraw before mutual → revoked; respond on revoked → 409', async () => {
  const { eventId, a, b } = await setupEventPair('t8');
  const created = await createIntro(a, { target_profile_id: b.profileId, event_id: eventId });
  const introId = ((await created.json()) as { introduction: { id: string } }).introduction.id;

  const withdraw = await respond(a, introId, { decision: 'withdraw' });
  assertStatus(withdraw, 200);

  const sql = getSql();
  const intro = await sql<{ state: string }[]>`SELECT state FROM introductions WHERE id = ${introId}`;
  assert.equal(intro[0]?.state, 'revoked');

  const lateRespond = await respond(b, introId, { decision: 'accept' });
  assertStatus(lateRespond, 409);
});

test('introductions: non-party respond → 404 without leaking existence', async () => {
  const { eventId, a, b } = await setupEventPair('t9');
  const outsider = await login('t9-outsider');
  const created = await createIntro(a, { target_profile_id: b.profileId, event_id: eventId });
  const introId = ((await created.json()) as { introduction: { id: string } }).introduction.id;

  const res = await respond(outsider, introId, { decision: 'accept' });
  assertStatus(res, 404);
  const get = await getIntro(outsider, introId);
  assertStatus(get, 404);
  void eventId;
});

test('introductions: personal context (no event) uses personal:<min> key and is idempotent', async () => {
  const a = await login('t10-a', { offers: ['x'], needs: ['y'] });
  const b = await login('t10-b', { offers: ['y'], needs: ['x'] });

  const res = await createIntro(a, { target_profile_id: b.profileId, reveal_fields: [] });
  assertStatus(res, 200);
  const body = (await res.json()) as { introduction: { id: string; context_key: string } };
  const minId = [a.profileId, b.profileId].sort()[0]!;
  assert.equal(body.introduction.context_key, `personal:${minId}`);

  const again = await createIntro(b, { target_profile_id: a.profileId, reveal_fields: [] });
  const againBody = (await again.json()) as { introduction: { id: string }; already_existed: boolean };
  assert.equal(againBody.introduction.id, body.introduction.id, 'reverse personal intro reuses the canonical pair');
  assert.equal(againBody.already_existed, true);
});

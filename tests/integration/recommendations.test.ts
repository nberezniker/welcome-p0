import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { PATCH as membershipPatchRoute } from '../../src/app/api/me/memberships/[membershipId]/route';
import { GET as recommendationsRoute } from '../../src/app/api/events/[eventIdOrSlug]/recommendations/route';
import { getSql, closeSql } from '../../src/lib/db';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

after(async () => {
  await closeSql();
});

async function login(prefix: string, tags: { offers?: string[]; needs?: string[]; languages?: string[] } = {}): Promise<{ cookie: string; accountId: string; profileId: string }> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: {
        display_name: `Rec ${prefix}`,
        languages: tags.languages ?? ['en'],
        offer_tags: tags.offers ?? [],
        need_tags: tags.needs ?? [],
      },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { cookie, accountId, profileId: rows[0]!.id };
}

async function createEvent(cookie: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'Rec Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC', ...overrides },
      cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string; slug: string } }).event;
}

async function join(cookie: string, idOrSlug: string): Promise<Response> {
  return joinRoute(makeRequest(`/api/events/${idOrSlug}/join`, { body: {}, cookie }), {
    params: Promise.resolve({ eventIdOrSlug: idOrSlug }),
  });
}

/** Join + opt in to directory + matching stays enabled (default). */
async function joinAndOptIn(user: { cookie: string; profileId: string }, idOrSlug: string): Promise<void> {
  await join(user.cookie, idOrSlug);
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM event_memberships WHERE profile_id = ${user.profileId} AND event_id = (SELECT id FROM events WHERE slug = ${idOrSlug} OR id::text = ${idOrSlug})
  `;
  const mid = rows[0]!.id;
  const res = await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${mid}`, { body: { directory_visible: true }, cookie: user.cookie }),
    { params: Promise.resolve({ membershipId: mid }) },
  );
  assertStatus(res, 200);
}

async function recommendations(user: { cookie: string }, idOrSlug: string): Promise<Response> {
  return recommendationsRoute(makeRequest(`/api/events/${idOrSlug}/recommendations`, { cookie: user.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: idOrSlug }),
  });
}

async function membershipIdOf(profileId: string, eventId: string): Promise<string> {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM event_memberships WHERE profile_id = ${profileId} AND event_id = ${eventId}
  `;
  return rows[0]!.id;
}

test('recommendations: empty list is a normal outcome (200, no error)', async () => {
  const { cookie: org } = await login('rec-org');
  const e = await createEvent(org);
  const a = await login('rec-a', { offers: ['design'], needs: ['frontend'] });
  await joinAndOptIn(a, e.id);

  const res = await recommendations(a, e.id);
  assertStatus(res, 200);
  assert.deepEqual(((await res.json()) as { recommendations: unknown[] }).recommendations, []);
});

test('recommendations: 401 anonymous; 403 non-member', async () => {
  const { cookie: org } = await login('rec2-org');
  const e = await createEvent(org);
  const outsider = await login('rec2-outsider');

  const anon = await recommendationsRoute(makeRequest(`/api/events/${e.id}/recommendations`), {
    params: Promise.resolve({ eventIdOrSlug: e.id }),
  });
  assertStatus(anon, 401);

  assertStatus(await recommendations(outsider, e.id), 403);
});

test('recommendations: complementary pair returned with fact-based reasons only', async () => {
  const { cookie: org } = await login('rec3-org');
  const e = await createEvent(org);
  const a = await login('rec3-a', { offers: ['mentoring'], needs: ['frontend', 'design'] });
  const b = await login('rec3-b', { offers: ['frontend'], needs: ['mentoring'] });
  await joinAndOptIn(a, e.id);
  await joinAndOptIn(b, e.id);

  const res = await recommendations(a, e.id);
  assertStatus(res, 200);
  const body = (await res.json()) as { recommendations: Array<Record<string, unknown>> };
  assert.equal(body.recommendations.length, 1);
  const item = body.recommendations[0]!;
  assert.equal(item.profile_id, b.profileId);
  assert.deepEqual(item.reasons_for_me, ['frontend']);
  assert.deepEqual(item.reasons_for_them, ['mentoring']);
  assert.equal(item.algorithm, 'welcome_mutual_tags_v1');
  assert.equal(typeof item.score, 'number');

  const raw = JSON.stringify(body);
  // Allowlist: no private values ever leak into recommendations.
  assert.equal(raw.includes('email'), false);
  assert.equal(raw.includes('contact'), false);
  assert.equal(raw.includes('encrypted'), false);
  const allowed = new Set(['profile_id', 'display_name', 'headline', 'company', 'score', 'reasons_for_me', 'reasons_for_them', 'algorithm']);
  for (const key of Object.keys(item)) assert.ok(allowed.has(key), `unexpected field: ${key}`);
});

test('recommendations: not-visible / non-opted-in / non-member candidates are excluded', async () => {
  const { cookie: org } = await login('rec4-org');
  const e = await createEvent(org);
  const a = await login('rec4-a', { offers: ['x'], needs: ['y'] });
  const visible = await login('rec4-v', { offers: ['y'], needs: ['x'] });
  const joinedNotOptedIn = await login('rec4-join', { offers: ['y'], needs: ['x'] });
  const notJoined = await login('rec4-out', { offers: ['y'], needs: ['x'] });
  void notJoined;
  await joinAndOptIn(a, e.id);
  await joinAndOptIn(visible, e.id);
  await join(joinedNotOptedIn.cookie, e.id); // joins but does NOT opt in

  const res = await recommendations(a, e.id);
  const body = (await res.json()) as { recommendations: Array<{ profile_id: string }> };
  assert.deepEqual(body.recommendations.map((r) => r.profile_id), [visible.profileId]);
});

test('recommendations: blocks suppress candidates; matching_enabled=false excludes', async () => {
  const { cookie: org } = await login('rec5-org');
  const e = await createEvent(org);
  const a = await login('rec5-a', { offers: ['x'], needs: ['y'] });
  const blocked = await login('rec5-b', { offers: ['y'], needs: ['x'] });
  const disabled = await login('rec5-c', { offers: ['y'], needs: ['x'] });
  await joinAndOptIn(a, e.id);
  await joinAndOptIn(blocked, e.id);
  await joinAndOptIn(disabled, e.id);

  const sql = getSql();
  await sql`INSERT INTO blocks (blocker_account_id, target_account_id) VALUES (${a.accountId}, ${blocked.accountId})`;
  const disabledMid = await membershipIdOf(disabled.profileId, e.id);
  await sql`UPDATE event_memberships SET matching_enabled = false WHERE id = ${disabledMid}`;

  const res = await recommendations(a, e.id);
  const body = (await res.json()) as { recommendations: Array<{ profile_id: string }> };
  assert.deepEqual(body.recommendations, []);
});

test('recommendations: viewer with matching_enabled=false gets an empty list', async () => {
  const { cookie: org } = await login('rec6-org');
  const e = await createEvent(org);
  const a = await login('rec6-a', { offers: ['x'], needs: ['y'] });
  const b = await login('rec6-b', { offers: ['y'], needs: ['x'] });
  await joinAndOptIn(a, e.id);
  await joinAndOptIn(b, e.id);

  const sql = getSql();
  const aMid = await membershipIdOf(a.profileId, e.id);
  await sql`UPDATE event_memberships SET matching_enabled = false WHERE id = ${aMid}`;

  const res = await recommendations(a, e.id);
  assert.deepEqual(((await res.json()) as { recommendations: unknown[] }).recommendations, []);
});

test('recommendations: pending intro excludes the pair; declined excluded within cooldown, allowed after', async () => {
  const { cookie: org } = await login('rec7-org');
  const e = await createEvent(org);
  const a = await login('rec7-a', { offers: ['x'], needs: ['y'] });
  const b = await login('rec7-b', { offers: ['y'], needs: ['x'] });
  await joinAndOptIn(a, e.id);
  await joinAndOptIn(b, e.id);

  const sql = getSql();
  const contextKey = 'event:' + e.id;
  await sql`
    INSERT INTO introductions (event_id, profile_a, profile_b, context_key, state)
    VALUES (${e.id}, ${a.profileId}, ${b.profileId}, ${contextKey}, 'declined')
  `;

  // Within the default 30-day cooldown → excluded.
  let res = await recommendations(a, e.id);
  assert.deepEqual(((await res.json()) as { recommendations: unknown[] }).recommendations, []);

  // Push the intro beyond the cooldown → pair becomes recommendable again.
  await sql`UPDATE introductions SET created_at = now() - interval '31 days' WHERE context_key = ${contextKey}`;
  res = await recommendations(a, e.id);
  const body = (await res.json()) as { recommendations: Array<{ profile_id: string }> };
  assert.deepEqual(body.recommendations.map((r) => r.profile_id), [b.profileId]);

  // An ACTIVE (pending) pair is excluded regardless of age.
  await sql`UPDATE introductions SET state = 'pending', created_at = now() - interval '31 days' WHERE context_key = ${contextKey}`;
  res = await recommendations(a, e.id);
  assert.deepEqual(((await res.json()) as { recommendations: unknown[] }).recommendations, []);
});

test('recommendations: tie-break is stable by profile id (score and pending equal)', async () => {
  const { cookie: org } = await login('rec8-org');
  const e = await createEvent(org);
  const a = await login('rec8-a', { offers: ['x'], needs: ['y'] });
  const c1 = await login('rec8-c1', { offers: ['y'], needs: ['x'] });
  const c2 = await login('rec8-c2', { offers: ['y'], needs: ['x'] });
  await joinAndOptIn(a, e.id);
  await joinAndOptIn(c1, e.id);
  await joinAndOptIn(c2, e.id);

  const res = await recommendations(a, e.id);
  const body = (await res.json()) as { recommendations: Array<{ profile_id: string; score: number }> };
  assert.equal(body.recommendations.length, 2);
  assert.equal(body.recommendations[0]!.score, body.recommendations[1]!.score);
  const sorted = [...body.recommendations.map((r) => r.profile_id)].sort();
  assert.deepEqual(body.recommendations.map((r) => r.profile_id), sorted);
});

test('recommendations: per-event tag override is used for matching', async () => {
  const { cookie: org } = await login('rec9-org');
  const e = await createEvent(org);
  const a = await login('rec9-a', { offers: ['generic'], needs: ['seed-money'] });
  const b = await login('rec9-b', { offers: ['nothing-useful'], needs: ['generic'] });
  await joinAndOptIn(a, e.id);
  await joinAndOptIn(b, e.id);

  // b overrides their event offer_tags to 'seed-money'.
  const bMid = await membershipIdOf(b.profileId, e.id);
  const patch = await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${bMid}`, { body: { offer_tags: ['seed-money'] }, cookie: b.cookie }),
    { params: Promise.resolve({ membershipId: bMid }) },
  );
  assertStatus(patch, 200);

  const res = await recommendations(a, e.id);
  const body = (await res.json()) as { recommendations: Array<{ profile_id: string; reasons_for_me: string[] }> };
  assert.equal(body.recommendations.length, 1);
  assert.deepEqual(body.recommendations[0]!.reasons_for_me, ['seed-money']);
});

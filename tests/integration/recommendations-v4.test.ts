import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { getSql, closeSql } from '../../src/lib/db';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as upsertProfile } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { GET as recommendationsRoute } from '../../src/app/api/events/[eventIdOrSlug]/recommendations/route';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';
import { RECOMMENDATION_MODES } from '../../src/domain/networking-score';

/**
 * Matching v4 over real HTTP + DB (packet 5): the four modes of §B4 ask four
 * different questions about the SAME event, the two-line reasons come out of the
 * API as codes, and `excluded_reason` explains a short list.
 */

after(async () => {
  await closeSql();
});

interface User {
  cookie: string;
  profileId: string;
}

async function login(prefix: string, body: Record<string, unknown> = {}): Promise<User> {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail(prefix));
  const accountId = await accountIdFromCookie(cookie);
  const res = await upsertProfile(
    makeRequest('/api/me/profile', { cookie, body: { display_name: `V4 ${prefix}`, languages: ['en'], ...body } }),
  );
  assertStatus(res, 200);
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { cookie, profileId: rows[0]!.id };
}

async function createEvent(cookie: string): Promise<{ id: string; slug: string }> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'V4 Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string; slug: string } }).event;
}

/** Join + opt in: the candidate side of every v4 check. */
async function joinVisible(user: User, idOrSlug: string): Promise<void> {
  const joined = await joinRoute(makeRequest(`/api/events/${idOrSlug}/join`, { body: {}, cookie: user.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: idOrSlug }),
  });
  assertStatus(joined, 200);
  const sql = getSql();
  await sql`
    UPDATE event_memberships SET directory_visible = true, matching_enabled = true
    WHERE profile_id = ${user.profileId} AND event_id = (
      SELECT id FROM events WHERE slug = ${idOrSlug} OR id::text = ${idOrSlug} LIMIT 1
    )
  `;
}

interface Item {
  profile_id: string;
  score: number;
  mode: string;
  algorithm: string;
  reasons_for_me: { code: string }[];
  reasons_for_them: { code: string }[];
  reasons_useful: { code: string; params: Record<string, unknown> }[];
  reasons_growth: { code: string; params: Record<string, unknown> }[];
}

async function recommendations(
  user: User,
  eventId: string,
  mode?: string,
): Promise<{ items: Item[]; excluded_reason: string | null; excluded_count: number }> {
  const url = `/api/events/${eventId}/recommendations${mode ? `?mode=${mode}` : ''}`;
  const res = await recommendationsRoute(makeRequest(url, { cookie: user.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: eventId }),
  });
  assertStatus(res, 200);
  const body = (await res.json()) as {
    mode: string;
    recommendations: Item[];
    excluded_reason: string | null;
    excluded_count: number;
  };
  if (mode) assert.equal(body.mode, mode, 'the response echoes the requested mode');
  return { items: body.recommendations, excluded_reason: body.excluded_reason, excluded_count: body.excluded_count };
}

/** The shared cast: one viewer, one peer, one teacher, one outsider. */
async function fourSides(prefix: string): Promise<{
  eventId: string;
  viewer: User;
  peer: User;
  teacher: User;
  outsider: User;
}> {
  const viewer = await login(`${prefix}-viewer`, {
    need_intents: ['seeking-mentor'],
    offer_intents: ['mentoring'],
    interests: ['ai-ml', 'startups'],
    industry: 'ai-saas',
    job_function: 'founder-ceo',
    goals: ['learn-skill'],
  });
  const event = await createEvent(viewer.cookie);
  const peer = await login(`${prefix}-peer`, {
    interests: ['ai-ml', 'startups'],
    industry: 'ai-saas',
    job_function: 'founder-ceo',
  });
  const teacher = await login(`${prefix}-teacher`, { offer_intents: ['mentoring'], interests: ['ai-ml'] });
  const outsider = await login(`${prefix}-outsider`, {
    interests: ['ai-ml'],
    industry: 'health-beauty',
    job_function: 'design',
  });
  // The organizer is not a member of their own event: the viewer joins too.
  for (const user of [viewer, peer, teacher, outsider]) await joinVisible(user, event.id);
  return { eventId: event.id, viewer, peer, teacher, outsider };
}

test('v4: the four modes answer four different questions about the same event', async () => {
  const { eventId, viewer, peer, teacher, outsider } = await fourSides('v4-modes');

  const useful = await recommendations(viewer, eventId, 'useful');
  const grow = await recommendations(viewer, eventId, 'grow');
  const similar = await recommendations(viewer, eventId, 'similar');
  const explore = await recommendations(viewer, eventId, 'explore');

  assert.equal(useful.items[0]?.profile_id, teacher.profileId, 'useful = who closes my request');
  assert.equal(grow.items[0]?.profile_id, teacher.profileId, 'grow = who I can learn from');
  assert.equal(similar.items[0]?.profile_id, peer.profileId, 'similar = who is like me');
  assert.equal(explore.items[0]?.profile_id, outsider.profileId, 'explore = a different context, same topic');

  const order = (items: Item[]) => items.map((i) => i.profile_id).join(',');
  const orders = new Set([order(useful.items), order(grow.items), order(similar.items), order(explore.items)]);
  assert.equal(orders.size >= 3, true, `modes must not collapse into one list: ${[...orders].join(' | ')}`);

  // Default mode is `useful` (no query parameter).
  const fallback = await recommendations(viewer, eventId);
  assert.deepEqual(fallback.items.map((i) => i.profile_id), useful.items.map((i) => i.profile_id));
  for (const item of fallback.items) assert.equal(item.mode, 'useful');
});

test('v4: an unknown mode is a 400, not a silent fallback', async () => {
  const { eventId, viewer } = await fourSides('v4-badmode');
  const res = await recommendationsRoute(
    makeRequest(`/api/events/${eventId}/recommendations?mode=best`, { cookie: viewer.cookie }),
    { params: Promise.resolve({ eventIdOrSlug: eventId }) },
  );
  assertStatus(res, 400);
  assert.equal(((await res.json()) as { code: string }).code, 'invalid_mode');
});

test('v4: the two lines are structural codes with the facts the sentence needs', async () => {
  const { eventId, viewer, teacher, peer } = await fourSides('v4-reasons');
  const { items } = await recommendations(viewer, eventId, 'useful');
  const teacherItem = items.find((i) => i.profile_id === teacher.profileId)!;
  assert.ok(teacherItem);
  assert.equal(teacherItem.algorithm, 'welcome_usefulness_v4');

  // Line 1 «Польза»: the request this person closes.
  assert.ok(
    teacherItem.reasons_useful.some(
      (r) => r.code === 'need_covered' && r.params['need'] === 'seeking-mentor',
    ),
    `expected the mentor request to be covered: ${JSON.stringify(teacherItem.reasons_useful)}`,
  );
  // Line 2 «Развитие»: what they can teach.
  assert.ok(
    teacherItem.reasons_growth.some((r) => r.code === 'can_teach' && r.params['offer'] === 'mentoring'),
    `expected the teaching offer: ${JSON.stringify(teacherItem.reasons_growth)}`,
  );
  // The v3 fact list rides along so the UI has one renderer for both layers.
  assert.ok(teacherItem.reasons_for_me.length > 0);
  assert.ok(teacherItem.reasons_for_them.length > 0);

  // A peer is recommended on shared context, with the interest fact on line 1.
  const similar = await recommendations(viewer, eventId, 'similar');
  const peerItem = similar.items.find((i) => i.profile_id === peer.profileId)!;
  assert.ok(peerItem.reasons_useful.some((r) => r.code === 'shared_interests'), JSON.stringify(peerItem.reasons_useful));
  assert.ok(peerItem.reasons_useful.some((r) => r.code === 'same_context'));

  // Codes only — never a rendered sentence.
  const raw = JSON.stringify(items);
  assert.equal(raw.includes('You are both into'), false);
  assert.equal(raw.includes('Advances your goal'), false);
});

test('v4: excluded_reason explains an empty list instead of leaving a blank strip', async () => {
  // Two interest-twins: v3 would show them, the usefulness gate will not.
  const viewer = await login('v4-excl-viewer', { interests: ['ai-ml', 'startups', 'saas'] });
  const event = await createEvent(viewer.cookie);
  const twin = await login('v4-excl-twin', { interests: ['ai-ml', 'startups', 'design-systems'] });
  for (const user of [viewer, twin]) await joinVisible(user, event.id);

  const useful = await recommendations(viewer, event.id, 'useful');
  assert.deepEqual(useful.items, []);
  assert.equal(useful.excluded_reason, 'gate_not_met');
  assert.equal(useful.excluded_count, 1);

  // …and the same pair is exactly what "similar" is for.
  const similar = await recommendations(viewer, event.id, 'similar');
  assert.deepEqual(similar.items.map((i) => i.profile_id), [twin.profileId]);
  assert.equal(similar.excluded_reason, null);

  // An empty event has nobody to reject at all.
  const lonely = await login('v4-excl-lonely', { interests: ['ai-ml'] });
  const emptyEvent = await createEvent(lonely.cookie);
  await joinVisible(lonely, emptyEvent.id);
  const empty = await recommendations(lonely, emptyEvent.id, 'useful');
  assert.deepEqual(empty.items, []);
  assert.equal(empty.excluded_reason, 'no_candidates');
  assert.equal(empty.excluded_count, 0);
});

test('v4: every recommendation mode is reachable and stays inside the item allowlist', async () => {
  const { eventId, viewer } = await fourSides('v4-allow');
  const allowed = new Set([
    'profile_id',
    'display_name',
    'headline',
    'company',
    'score',
    'mode',
    'reasons_for_me',
    'reasons_for_them',
    'reasons_useful',
    'reasons_growth',
    'algorithm',
  ]);

  for (const mode of RECOMMENDATION_MODES) {
    const { items } = await recommendations(viewer, eventId, mode);
    for (const item of items) {
      for (const key of Object.keys(item)) assert.ok(allowed.has(key), `${mode}: unexpected field ${key}`);
      assert.equal(item.mode, mode);
      assert.equal(typeof item.score, 'number');
      assert.ok(item.score >= 0 && item.score <= 100);
    }
    const raw = JSON.stringify(items);
    assert.equal(raw.includes('email'), false);
    assert.equal(raw.includes('goals'), false, 'a candidate’s goals must never travel');
  }
});

/**
 * THE STRIP IS A LIST OF OTHER PEOPLE, IN EVERY MODE.
 *
 * This is the rule the DIRECTORY already holds and that the strip must hold with
 * it (`tests/integration/directory.test.ts`: "self excluded", in both the default
 * and the mode=all listing). It is asserted here rather than assumed because the
 * strip is a different query, a different route and a different ranker, and a
 * recommendation is the one list where showing the reader themselves is not
 * merely noise: in mode=similar it is guaranteed (the viewer shares every one of
 * their own interests), in mode=useful the viewer's own needs would cover their
 * own offers, and the "score" beside their name would read as a claim about
 * themselves. Verified over the real HTTP route + real DB, four modes at once,
 * on a viewer who is deliberately the richest candidate in the event.
 */
test('v4: the viewer is never in their own strip — self is excluded in every mode', async () => {
  const { eventId, viewer, peer, teacher, outsider } = await fourSides('v4-self');

  for (const mode of RECOMMENDATION_MODES) {
    const { items } = await recommendations(viewer, eventId, mode);
    assert.equal(
      items.some((item) => item.profile_id === viewer.profileId),
      false,
      `${mode}: the viewer must never be recommended to themselves`,
    );
    // The mode is not empty by accident: this viewer is the trap the assertion
    // above is about — mode=similar pairs them with their own twin, and the
    // viewer's own row is the one that would otherwise score highest.
    if (mode === 'similar') {
      assert.equal(items.some((item) => item.profile_id === peer.profileId), true, 'similar still finds the twin');
    }
  }

  // …and the three other members are the ones that DO appear, so the assertion
  // above is not passing because every list is empty.
  const seen = new Set<string>();
  for (const mode of RECOMMENDATION_MODES) {
    for (const item of (await recommendations(viewer, eventId, mode)).items) seen.add(item.profile_id);
  }
  for (const other of [peer, teacher, outsider]) {
    assert.equal(seen.has(other.profileId), true, 'every other member is recommended in at least one mode');
  }
});

test('v4: the viewer\'s own goals change the ranking; other people\'s goals are never read', async () => {
  const eventOwner = await login('v4-goals-owner', { interests: ['ai-ml'] });
  const event = await createEvent(eventOwner.cookie);
  await joinVisible(eventOwner, event.id);

  const investor = await login('v4-goals-investor', {
    offer_intents: ['investing'],
    interests: ['venture-capital'],
    // A private goal of the CANDIDATE: it must not influence anyone's ranking.
    goals: ['find-mentor'],
  });
  await joinVisible(investor, event.id);

  const founder = await login('v4-goals-founder', {
    need_intents: ['seeking-investment'],
    interests: ['venture-capital'],
    goals: ['fundraise'],
  });
  await joinVisible(founder, event.id);

  const withGoal = await recommendations(founder, event.id, 'useful');
  assert.equal(withGoal.items[0]?.profile_id, investor.profileId);
  assert.ok(
    withGoal.items[0]!.reasons_useful.some((r) => r.code === 'goal_advanced' && r.params['goal'] === 'fundraise'),
    JSON.stringify(withGoal.items[0]!.reasons_useful),
  );

  // The same candidate, seen by a viewer with an unrelated goal: no goal reason.
  const other = await login('v4-goals-other', {
    need_intents: ['seeking-investment'],
    interests: ['venture-capital'],
    goals: ['get-hired'],
  });
  await joinVisible(other, event.id);
  const withoutGoal = await recommendations(other, event.id, 'useful');
  const investorItem = withoutGoal.items.find((i) => i.profile_id === investor.profileId)!;
  assert.ok(investorItem, 'the pair is still recommended — a goal is a bonus, not a gate');
  assert.equal(
    investorItem.reasons_useful.some((r) => r.code === 'goal_advanced'),
    false,
    'an unrelated goal produces no sentence',
  );

  // Nothing in the payload reveals the candidate's own goals.
  const raw = JSON.stringify(withoutGoal.items);
  assert.equal(raw.includes('find-mentor'), false);
});

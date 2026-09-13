import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { GET as directoryRoute } from '../../src/app/api/events/[eventIdOrSlug]/directory/route';
import { PATCH as membershipPatchRoute } from '../../src/app/api/me/memberships/[membershipId]/route';
import { POST as attendanceRoute } from '../../src/app/api/me/memberships/[membershipId]/attendance/route';
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

async function login(prefix: string): Promise<User> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `Member ${prefix}`, languages: ['en'], offer_tags: ['offer-' + prefix], need_tags: ['need-' + prefix] },
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
      body: { name: 'Directory Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC', ...overrides },
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

async function membershipId(profileId: string, eventId: string): Promise<string> {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM event_memberships WHERE profile_id = ${profileId} AND event_id = ${eventId}
  `;
  return rows[0]!.id;
}

async function directory(user: User | null, idOrSlug: string): Promise<Response> {
  return directoryRoute(
    makeRequest(`/api/events/${idOrSlug}/directory`, user ? { cookie: user.cookie } : {}),
    { params: Promise.resolve({ eventIdOrSlug: idOrSlug }) },
  );
}

test('directory: anonymous → 401; non-member → 403 (AC-20b)', async () => {
  const { cookie: org } = await login('dir-org');
  const e = await createEvent(org);
  const outsider = await login('dir-outsider');

  const anon = await directory(null, e.id);
  assertStatus(anon, 401);

  const nonMember = await directory(outsider, e.id);
  assertStatus(nonMember, 403);
});

test('directory: member sees only visible active members; strict field allowlist', async () => {
  const { cookie: org } = await login('dir2-org');
  const { profileId: orgProfileId } = await login('dir2-orgprofile');
  void orgProfileId;
  const e = await createEvent(org);

  const a = await login('dir2-a');
  const b = await login('dir2-b');
  const hidden = await login('dir2-hidden');
  await join(a.cookie, e.id);
  await join(b.cookie, e.id);
  await join(hidden.cookie, e.id);

  // h hides themselves from the directory.
  const hiddenMid = await membershipId(hidden.profileId, e.id);
  const hideRes = await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${hiddenMid}`, { body: { directory_visible: false }, cookie: hidden.cookie }),
    { params: Promise.resolve({ membershipId: hiddenMid }) },
  );
  assertStatus(hideRes, 200);

  const res = await directory(a, e.id);
  assertStatus(res, 200);
  const body = (await res.json()) as {
    members: Array<Record<string, unknown>>;
  };
  // Join sets directory_visible=false; members must OPT IN to the directory.
  assert.equal(body.members.length, 0, 'nobody opted in yet');

  const aMid = await membershipId(a.profileId, e.id);
  const bMid = await membershipId(b.profileId, e.id);
  await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${aMid}`, { body: { directory_visible: true }, cookie: a.cookie }),
    { params: Promise.resolve({ membershipId: aMid }) },
  );
  await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${bMid}`, {
      body: {
        directory_visible: true,
        offer_tags: ['seed-money'],
        need_tags: ['frontend'],
        offer_intents: ['open-to-cofound'],
        need_intents: ['seeking-investment'],
        interests: ['ai-ml', 'startups'],
        industry: 'ai-saas',
        job_function: 'founder-ceo',
      },
      cookie: b.cookie,
    }),
    { params: Promise.resolve({ membershipId: bMid }) },
  );

  const res2 = await directory(a, e.id);
  const body2 = (await res2.json()) as { members: Array<Record<string, unknown>> };
  assert.equal(body2.members.length, 2);

  const bEntry = body2.members.find((m) => m.profile_id === b.profileId);
  assert.ok(bEntry);
  assert.deepEqual(bEntry?.offer_tags, ['seed-money']);
  assert.equal(bEntry?.display_name, 'Member dir2-b');
  // Taxonomy v3 axes are part of the directory projection (catalogue values only).
  assert.deepEqual(bEntry?.offer_intents, ['open-to-cofound']);
  assert.deepEqual(bEntry?.need_intents, ['seeking-investment']);
  assert.deepEqual(bEntry?.interests, ['ai-ml', 'startups']);
  assert.equal(bEntry?.industry, 'ai-saas');
  assert.equal(bEntry?.job_function, 'founder-ceo');

  // Strict allowlist: no emails, contacts, notes, account ids, revisions, keywords.
  const allowed = new Set([
    'profile_id', 'display_name', 'headline', 'company', 'offer_tags', 'need_tags',
    'need_intents', 'offer_intents', 'interests', 'industry', 'job_function',
  ]);
  for (const m of body2.members) {
    for (const key of Object.keys(m)) {
      assert.ok(allowed.has(key), `unexpected field in directory response: ${key}`);
    }
  }
  const raw = JSON.stringify(body2);
  assert.equal(raw.includes('email'), false);
  assert.equal(raw.includes('contact'), false);
  assert.equal(raw.includes('encrypted'), false);
  assert.equal(raw.includes('account'), false);
  assert.equal(raw.includes('keyword'), false);
});

test('directory: blocks suppress visibility in both directions', async () => {
  const { cookie: org } = await login('dir3-org');
  const e = await createEvent(org);
  const a = await login('dir3-a');
  const b = await login('dir3-b');
  await join(a.cookie, e.id);
  await join(b.cookie, e.id);

  const aMid = await membershipId(a.profileId, e.id);
  const bMid = await membershipId(b.profileId, e.id);
  await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${aMid}`, { body: { directory_visible: true }, cookie: a.cookie }),
    { params: Promise.resolve({ membershipId: aMid }) },
  );
  await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${bMid}`, { body: { directory_visible: true }, cookie: b.cookie }),
    { params: Promise.resolve({ membershipId: bMid }) },
  );

  const sql = getSql();
  // a blocks b → b disappears for a (and a disappears for b — mutual suppression).
  await sql`INSERT INTO blocks (blocker_account_id, target_account_id) VALUES (${a.accountId}, ${b.accountId})`;

  const forA = await directory(a, e.id);
  const bodyA = (await forA.json()) as { members: Array<{ profile_id: string }> };
  assert.equal(bodyA.members.some((m) => m.profile_id === b.profileId), false, 'blocked member is hidden');

  const forB = await directory(b, e.id);
  const bodyB = (await forB.json()) as { members: Array<{ profile_id: string }> };
  assert.equal(bodyB.members.some((m) => m.profile_id === a.profileId), false, 'blocking member is hidden from the blocked side');
});

test('directory: directory_close_at in the past → 403 directory_closed', async () => {
  const { cookie: org } = await login('dir4-org');
  const e = await createEvent(org, { name: 'Closed Dir' });
  const a = await login('dir4-a');
  await join(a.cookie, e.id);

  const sql = getSql();
  await sql`UPDATE events SET directory_close_at = now() - interval '1 hour' WHERE id = ${e.id}`;

  const res = await directory(a, e.id);
  assertStatus(res, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'directory_closed');
});

test('membership PATCH: foreign membership → 403; invalid body → 400; leave works', async () => {
  const { cookie: org } = await login('dir5-org');
  const e = await createEvent(org);
  const a = await login('dir5-a');
  const stranger = await login('dir5-stranger');
  await join(a.cookie, e.id);
  const aMid = await membershipId(a.profileId, e.id);

  const foreign = await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${aMid}`, { body: { directory_visible: true }, cookie: stranger.cookie }),
    { params: Promise.resolve({ membershipId: aMid }) },
  );
  assertStatus(foreign, 403);

  const invalid = await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${aMid}`, { body: { directory_visible: 'yes' }, cookie: a.cookie }),
    { params: Promise.resolve({ membershipId: aMid }) },
  );
  assertStatus(invalid, 400);

  const badState = await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${aMid}`, { body: { state: 'blocked' }, cookie: a.cookie }),
    { params: Promise.resolve({ membershipId: aMid }) },
  );
  assertStatus(badState, 400);

  const leave = await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${aMid}`, { body: { state: 'left' }, cookie: a.cookie }),
    { params: Promise.resolve({ membershipId: aMid }) },
  );
  assertStatus(leave, 200);
  const leaveBody = (await leave.json()) as { membership: { state: string } };
  assert.equal(leaveBody.membership.state, 'left');

  const sql = getSql();
  const audits = await sql<{ id: number }[]>`
    SELECT id FROM audit_events WHERE action = 'membership.left' AND target_id = ${aMid}
  `;
  assert.equal(audits.length, 1);
});

test('attendance: self-report sets attendance_source; foreign membership → 403', async () => {
  const { cookie: org } = await login('dir6-org');
  const e = await createEvent(org);
  const a = await login('dir6-a');
  const stranger = await login('dir6-stranger');
  await join(a.cookie, e.id);
  const aMid = await membershipId(a.profileId, e.id);

  const foreign = await attendanceRoute(
    makeRequest(`/api/me/memberships/${aMid}/attendance`, { body: { present: true }, cookie: stranger.cookie }),
    { params: Promise.resolve({ membershipId: aMid }) },
  );
  assertStatus(foreign, 403);

  const present = await attendanceRoute(
    makeRequest(`/api/me/memberships/${aMid}/attendance`, { body: { present: true }, cookie: a.cookie }),
    { params: Promise.resolve({ membershipId: aMid }) },
  );
  assertStatus(present, 200);
  assert.equal(((await present.json()) as { attendance_source: string }).attendance_source, 'self');

  const absent = await attendanceRoute(
    makeRequest(`/api/me/memberships/${aMid}/attendance`, { body: { present: false }, cookie: a.cookie }),
    { params: Promise.resolve({ membershipId: aMid }) },
  );
  assertStatus(absent, 200);
  assert.equal(((await absent.json()) as { attendance_source: string }).attendance_source, 'none');

  const invalid = await attendanceRoute(
    makeRequest(`/api/me/memberships/${aMid}/attendance`, { body: { present: 'yes' }, cookie: a.cookie }),
    { params: Promise.resolve({ membershipId: aMid }) },
  );
  assertStatus(invalid, 400);
});

// ---------------------------------------------------------------------------
// Pass B: free-text search (q) and the `function` alias of job_function
// ---------------------------------------------------------------------------

/** Login with a full v3 profile body (the shared `login` helper only sets tags). */
async function loginWith(prefix: string, body: Record<string, unknown>): Promise<User> {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail(prefix));
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `Search ${prefix}`, languages: ['en'], offer_tags: [], need_tags: [], ...body },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { cookie, accountId, profileId: rows[0]!.id };
}

async function directoryQuery(user: User, idOrSlug: string, query: string): Promise<Response> {
  return directoryRoute(
    makeRequest(`/api/events/${idOrSlug}/directory?${query}`, { cookie: user.cookie }),
    { params: Promise.resolve({ eventIdOrSlug: idOrSlug }) },
  );
}

async function visible(user: User, eventId: string): Promise<void> {
  const mid = await membershipId(user.profileId, eventId);
  const res = await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${mid}`, { body: { directory_visible: true }, cookie: user.cookie }),
    { params: Promise.resolve({ membershipId: mid }) },
  );
  assertStatus(res, 200);
}

test('directory: q searches name, headline, company and the member keywords — but never projects them', async () => {
  const { cookie: org } = await login('dirq-org');
  const e = await createEvent(org);
  const viewer = await loginWith('dirq-viewer', {});
  const alice = await loginWith('dirq-alice', {
    headline: 'Building solar analytics',
    company: 'Sunbeam Labs',
    keywords: ['solartech'],
    interests: ['ai-ml'],
  });
  const bob = await loginWith('dirq-bob', {
    headline: 'Beauty retail operator',
    company: 'Glow Retail',
    keywords: ['skincare-routine'],
    interests: ['beauty-industry'],
  });
  for (const u of [viewer, alice, bob]) await join(u.cookie, e.id);
  for (const u of [viewer, alice, bob]) await visible(u, e.id);

  const all = await directoryQuery(viewer, e.id, 'mode=all');
  assertStatus(all, 200);
  assert.equal(((await all.json()) as { members: unknown[] }).members.length, 3);

  const byName = await directoryQuery(viewer, e.id, 'mode=all&q=alice');
  assert.deepEqual(
    ((await byName.json()) as { members: { profile_id: string }[] }).members.map((m) => m.profile_id),
    [alice.profileId],
  );

  const byCompany = await directoryQuery(viewer, e.id, 'mode=all&q=glow');
  assert.deepEqual(
    ((await byCompany.json()) as { members: { profile_id: string }[] }).members.map((m) => m.profile_id),
    [bob.profileId],
  );

  const byHeadline = await directoryQuery(viewer, e.id, 'mode=all&q=solar');
  assert.deepEqual(
    ((await byHeadline.json()) as { members: { profile_id: string }[] }).members.map((m) => m.profile_id),
    [alice.profileId],
  );

  // Matching a keyword must not leak the keyword itself into the projection.
  const byKeyword = await directoryQuery(viewer, e.id, 'mode=all&q=skincare');
  const keywordBody = (await byKeyword.json()) as { members: { profile_id: string }[] };
  assert.deepEqual(keywordBody.members.map((m) => m.profile_id), [bob.profileId]);
  assert.equal(JSON.stringify(keywordBody).includes('skincare-routine'), false);
  assert.equal(JSON.stringify(keywordBody).includes('keyword'), false);

  // No match is an empty list, not an error.
  const none = await directoryQuery(viewer, e.id, 'mode=all&q=nobody-has-this');
  assertStatus(none, 200);
  assert.deepEqual(((await none.json()) as { members: unknown[] }).members, []);

  // A LIKE wildcard in the input is treated as a literal, not as a pattern.
  const wildcard = await directoryQuery(viewer, e.id, 'mode=all&q=%25');
  assertStatus(wildcard, 200);
  assert.deepEqual(((await wildcard.json()) as { members: unknown[] }).members, []);
});

test('directory: `function` is an accepted alias of job_function, and contradictions are rejected', async () => {
  const { cookie: org } = await login('dirf-org');
  const e = await createEvent(org);
  const viewer = await loginWith('dirf-viewer', {});
  const founder = await loginWith('dirf-founder', { job_function: 'founder-ceo', industry: 'ai-saas' });
  const designer = await loginWith('dirf-designer', { job_function: 'design', industry: 'ai-saas' });
  for (const u of [viewer, founder, designer]) await join(u.cookie, e.id);
  for (const u of [viewer, founder, designer]) await visible(u, e.id);

  const alias = await directoryQuery(viewer, e.id, 'mode=all&function=founder-ceo');
  assertStatus(alias, 200);
  assert.deepEqual(
    ((await alias.json()) as { members: { profile_id: string }[] }).members.map((m) => m.profile_id),
    [founder.profileId],
  );

  const canonical = await directoryQuery(viewer, e.id, 'mode=all&job_function=design');
  assert.deepEqual(
    ((await canonical.json()) as { members: { profile_id: string }[] }).members.map((m) => m.profile_id),
    [designer.profileId],
  );

  const both = await directoryQuery(viewer, e.id, 'mode=all&function=design&job_function=founder-ceo');
  assert.equal(both.status, 400);
  assert.equal(((await both.json()) as { code: string }).code, 'invalid_job_function');

  const agreed = await directoryQuery(viewer, e.id, 'mode=all&function=design&job_function=design');
  assertStatus(agreed, 200);

  const unknown = await directoryQuery(viewer, e.id, 'mode=all&function=astronaut');
  assert.equal(unknown.status, 400);
  assert.equal(((await unknown.json()) as { code: string }).code, 'invalid_job_function');
});

test('directory: q composes with modes and facets', async () => {
  const { cookie: org } = await login('dirc-org');
  const e = await createEvent(org);
  const viewer = await loginWith('dirc-viewer', { offer_intents: ['offering-services'], interests: ['ai-ml'] });
  const match = await loginWith('dirc-match', {
    need_intents: ['seeking-clients'],
    interests: ['ai-ml'],
    headline: 'Needs a vendor',
  });
  const other = await loginWith('dirc-other', {
    need_intents: ['seeking-clients'],
    interests: ['beauty-industry'],
    headline: 'Also needs a vendor',
  });
  for (const u of [viewer, match, other]) await join(u.cookie, e.id);
  for (const u of [viewer, match, other]) await visible(u, e.id);

  // intent mode: both seekers match the viewer's offer…
  const intent = await directoryQuery(viewer, e.id, 'mode=intent');
  const intentIds = ((await intent.json()) as { members: { profile_id: string }[] }).members.map((m) => m.profile_id);
  assert.ok(intentIds.includes(match.profileId) && intentIds.includes(other.profileId));

  // …adding q narrows to one, and the interest facet narrows further.
  const narrowed = await directoryQuery(viewer, e.id, 'mode=intent&q=needs+a+vendor&interest=ai-ml');
  assert.deepEqual(
    ((await narrowed.json()) as { members: { profile_id: string }[] }).members.map((m) => m.profile_id),
    [match.profileId],
  );

  // The same query with the other interest facet returns only the other member:
  // the facets filter, they never widen.
  const beauty = await directoryQuery(viewer, e.id, 'mode=intent&q=needs+a+vendor&interest=beauty-industry');
  assert.deepEqual(
    ((await beauty.json()) as { members: { profile_id: string }[] }).members.map((m) => m.profile_id),
    [other.profileId],
  );
});

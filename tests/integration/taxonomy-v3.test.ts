import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../scripts/migrate.mjs';
import { getSql, closeSql } from '../../src/lib/db';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as upsertProfile, GET as getProfile } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { GET as directoryRoute } from '../../src/app/api/events/[eventIdOrSlug]/directory/route';
import { GET as recommendationsRoute } from '../../src/app/api/events/[eventIdOrSlug]/recommendations/route';
import { PATCH as membershipPatchRoute } from '../../src/app/api/me/memberships/[membershipId]/route';
import { GET as taxonomyRoute } from '../../src/app/api/taxonomy/route';
import { PUT as putContact } from '../../src/app/api/me/contacts/route';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

after(async () => {
  await closeSql();
});

interface User {
  cookie: string;
  accountId: string;
  profileId: string;
}

async function login(prefix: string, body: Record<string, unknown> = {}): Promise<User> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await upsertProfile(
    makeRequest('/api/me/profile', {
      cookie,
      body: { display_name: `V3 ${prefix}`, languages: ['en'], ...body },
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
      body: { name: 'V3 Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC', ...overrides },
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

/** Join and become visible in the directory. */
async function joinVisible(user: User, eventId: string): Promise<void> {
  assertStatus(await join(user.cookie, eventId), 200);
  const mid = await membershipId(user.profileId, eventId);
  assertStatus(
    await membershipPatchRoute(
      makeRequest(`/api/me/memberships/${mid}`, { body: { directory_visible: true }, cookie: user.cookie }),
      { params: Promise.resolve({ membershipId: mid }) },
    ),
    200,
  );
}

function directory(user: User | null, idOrSlug: string, query = ''): Promise<Response> {
  return directoryRoute(
    makeRequest(`/api/events/${idOrSlug}/directory${query}`, user ? { cookie: user.cookie } : {}),
    { params: Promise.resolve({ eventIdOrSlug: idOrSlug }) },
  );
}

function recommendations(user: User, idOrSlug: string, locale?: 'ru' | 'en'): Promise<Response> {
  const cookie = locale ? `${user.cookie}; welcome_locale=${locale}` : user.cookie;
  return recommendationsRoute(makeRequest(`/api/events/${idOrSlug}/recommendations`, { cookie }), {
    params: Promise.resolve({ eventIdOrSlug: idOrSlug }),
  });
}

// ---------------------------------------------------------------------------
// Migration 007
// ---------------------------------------------------------------------------

test('migration 007: v3 columns, GIN indexes and the enrichment ledger exist; re-running is a no-op', async () => {
  const sql = getSql();

  for (const table of ['profiles', 'event_memberships']) {
    const cols = await sql<{ column_name: string; is_nullable: string; data_type: string }[]>`
      SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_name = ${table}
    `;
    const names = new Set(cols.map((c) => c.column_name));
    for (const c of ['need_intents', 'offer_intents', 'interests', 'industry', 'job_function', 'keywords']) {
      assert.ok(names.has(c), `${table}.${c} must exist`);
    }
    for (const c of ['industry', 'job_function']) {
      const col = cols.find((x) => x.column_name === c)!;
      assert.equal(col.is_nullable, 'YES', `${table}.${c} must be nullable`);
    }
  }

  const indexes = await sql<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
  const names = indexes.map((i) => i.indexname);
  for (const idx of [
    'profiles_need_intents_gin', 'profiles_offer_intents_gin', 'profiles_interests_gin',
    'event_memberships_need_intents_gin', 'event_memberships_offer_intents_gin', 'event_memberships_interests_gin',
  ]) {
    assert.ok(names.includes(idx), `missing GIN index ${idx}`);
  }

  const ledger = await sql`SELECT to_regclass('public.enrichment_requests') AS reg`;
  assert.ok((ledger[0] as { reg: string | null } | undefined)?.reg, 'enrichment_requests must exist');

  // Applied through schema_migrations: a second run applies nothing.
  const second = await runMigrations();
  assert.deepEqual(second.applied, []);

  // The file itself is idempotent (safe to execute twice by hand).
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const content = await readFile(path.join(root, 'db', 'migrations', '007_taxonomy_v3.sql'), 'utf8');
  await sql.unsafe(content);
  await sql.unsafe(content);
});

// ---------------------------------------------------------------------------
// Public catalogue
// ---------------------------------------------------------------------------

test('GET /api/taxonomy: public, cacheable, full catalogue with RU+EN labels', async () => {
  const res = await taxonomyRoute();
  assertStatus(res, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');

  const body = (await res.json()) as {
    ok: boolean;
    version: string;
    intents: { id: string; need: { id: string; label: { ru: string; en: string } }; offer: { id: string } }[];
    interests: { id: string; group: string; label: { ru: string; en: string } }[];
    interest_groups: unknown[];
    functions: unknown[];
    industries: unknown[];
  };
  assert.equal(body.ok, true);
  assert.equal(body.version, 'v3');
  assert.equal(body.intents.length, 16);
  assert.ok(body.interests.length >= 70);
  assert.equal(body.functions.length, 14);
  assert.equal(body.industries.length, 12);
  assert.ok(body.intents[0]!.need.label.ru.length > 0);
  assert.ok(body.interests[0]!.label.en.length > 0);
  assert.ok(body.interest_groups.length > 0);
});

// ---------------------------------------------------------------------------
// Profile with v3 fields
// ---------------------------------------------------------------------------

test('profile: v3 axes round-trip, catalogue validation, revision semantics unchanged', async () => {
  const email = uniqueEmail('v3-profile');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);

  const createRes = await upsertProfile(
    makeRequest('/api/me/profile', {
      cookie,
      body: {
        display_name: 'V3 Profile',
        languages: ['ru'],
        need_intents: ['seeking-cofounder', 'seeking-investment'],
        offer_intents: ['advising'],
        interests: ['ai-ml', 'Стартапы', 'ai-ml'],
        industry: 'ai-saas',
        job_function: 'founder-ceo',
        keywords: [' ФудТех ', 'фудтех', 'B2B SaaS'],
      },
    }),
  );
  assertStatus(createRes, 200);
  const created = (await createRes.json()) as { profile: Record<string, unknown>; revision: number };
  assert.deepEqual(created.profile.need_intents, ['seeking-cofounder', 'seeking-investment']);
  assert.deepEqual(created.profile.offer_intents, ['advising']);
  assert.deepEqual(created.profile.interests, ['ai-ml', 'startups']);
  assert.equal(created.profile.industry, 'ai-saas');
  assert.equal(created.profile.job_function, 'founder-ceo');
  assert.deepEqual(created.profile.keywords, ['фудтех', 'b2b saas']);
  assert.equal(created.profile.revision, 1);

  // GET returns the same allowlisted shape.
  const getRes = await getProfile(makeRequest('/api/me/profile', { cookie }));
  assertStatus(getRes, 200);
  const fetched = (await getRes.json()) as { profile: Record<string, unknown> };
  assert.deepEqual(fetched.profile.need_intents, ['seeking-cofounder', 'seeking-investment']);
  assert.deepEqual(fetched.profile.keywords, ['фудтех', 'b2b saas']);

  // Unknown ids are rejected with a hint; limits are enforced.
  const unknown = await upsertProfile(
    makeRequest('/api/me/profile', { cookie, body: { display_name: 'X', revision: 1, interests: ['quantum-teleport'] } }),
  );
  assertStatus(unknown, 400);
  assert.equal(((await unknown.json()) as { code: string }).code, 'invalid_interests');

  const wrongSide = await upsertProfile(
    makeRequest('/api/me/profile', { cookie, body: { display_name: 'X', revision: 1, offer_intents: ['seeking-cofounder'] } }),
  );
  assertStatus(wrongSide, 400);
  assert.equal(((await wrongSide.json()) as { code: string }).code, 'invalid_offer_intents');

  const tooMany = await upsertProfile(
    makeRequest('/api/me/profile', {
      cookie,
      body: { display_name: 'X', revision: 1, interests: ['ai-ml', 'saas', 'dev-tools', 'automation', 'data-analytics', 'cybersecurity'] },
    }),
  );
  assertStatus(tooMany, 400);

  // prefer-not-to-say is accepted and stored as NULL.
  const declined = await upsertProfile(
    makeRequest('/api/me/profile', {
      cookie,
      body: { display_name: 'V3 Profile', revision: 1, job_function: 'prefer-not-to-say' },
    }),
  );
  assertStatus(declined, 200);
  const declinedBody = (await declined.json()) as { profile: Record<string, unknown>; revision: number };
  assert.equal(declinedBody.profile.job_function, null);
  assert.equal(declinedBody.revision, 2);

  // Stale revision keeps returning 409.
  const stale = await upsertProfile(
    makeRequest('/api/me/profile', { cookie, body: { display_name: 'V3 Profile', revision: 1 } }),
  );
  assertStatus(stale, 409);
});

// ---------------------------------------------------------------------------
// Directory filters
// ---------------------------------------------------------------------------

test('directory: intent / interest modes and facet filters narrow the visible members', async () => {
  const org = await login('v3-dir-org');
  const event = await createEvent(org.cookie);

  const founder = await login('v3-dir-founder', {
    need_intents: ['seeking-cofounder'],
    interests: ['ai-ml', 'startups'],
    job_function: 'founder-ceo',
    industry: 'ai-saas',
  });
  const mentor = await login('v3-dir-mentor', {
    offer_intents: ['open-to-cofound'],
    interests: ['ai-ml', 'design-systems'],
    job_function: 'engineering',
    industry: 'ai-saas',
  });
  const beauty = await login('v3-dir-beauty', {
    offer_intents: ['offering-services'],
    interests: ['skincare', 'beauty-industry'],
    job_function: 'marketing',
    industry: 'health-beauty',
  });

  for (const u of [founder, mentor, beauty]) await joinVisible(u, event.id);

  // mode=all with a facet filter on industry (the viewer is listed too — the
  // directory is not self-excluding — so compare the other members).
  const all = await directory(founder, event.id, '?mode=all&industry=ai-saas');
  assertStatus(all, 200);
  const allBody = (await all.json()) as { mode: string; members: { profile_id: string }[] };
  assert.equal(allBody.mode, 'all');
  assert.ok(allBody.members.some((m) => m.profile_id === founder.profileId), 'self is listed');
  assert.deepEqual(
    allBody.members.filter((m) => m.profile_id !== founder.profileId).map((m) => m.profile_id),
    [mentor.profileId],
    'beauty is filtered out by industry',
  );

  // mode=interest: shares ai-ml with mentor, not with beauty.
  const byInterest = await directory(founder, event.id, '?mode=interest');
  const byInterestBody = (await byInterest.json()) as { members: { profile_id: string }[] };
  assert.deepEqual(
    byInterestBody.members.filter((m) => m.profile_id !== founder.profileId).map((m) => m.profile_id),
    [mentor.profileId],
  );

  // mode=intent ("ищут то же, что могу я"): the viewer offers nothing here.
  const noOffers = await directory(founder, event.id, '?mode=intent');
  const noOffersBody = (await noOffers.json()) as { members: unknown[] };
  assert.deepEqual(noOffersBody.members, []);

  // …while the mentor (offering co-founder) sees whoever seeks a co-founder.
  const mentorView = await directory(mentor, event.id, '?mode=intent');
  const mentorBody = (await mentorView.json()) as { members: { profile_id: string }[] };
  assert.deepEqual(mentorBody.members.map((m) => m.profile_id), [founder.profileId]);

  // Explicit interest facet uses containment, not overlap-with-viewer.
  const facet = await directory(mentor, event.id, '?interest=skincare');
  const facetBody = (await facet.json()) as { members: { profile_id: string }[] };
  assert.deepEqual(facetBody.members.map((m) => m.profile_id), [beauty.profileId]);

  // Invalid params → 400 with the catalogue hint.
  const badMode = await directory(founder, event.id, '?mode=telepathy');
  assertStatus(badMode, 400);
  const badInterest = await directory(founder, event.id, '?interest=quantum-teleport');
  assertStatus(badInterest, 400);
  const badFunction = await directory(founder, event.id, '?job_function=astronaut');
  assertStatus(badFunction, 400);
  // Anonymous / non-members stay locked out.
  assertStatus(await directory(null, event.id), 401);
});

test('directory: profile-level intents surface when the membership has no override, and keywords never leak', async () => {
  const org = await login('v3-dir2-org');
  const event = await createEvent(org.cookie);
  const member = await login('v3-dir2-member', {
    offer_intents: ['open-to-cofound'],
    interests: ['ai-ml'],
    keywords: ['мой секретный ключ'],
  });
  await putContact(
    makeRequest('/api/me/contacts', {
      cookie: member.cookie,
      method: 'PUT',
      body: { kind: 'phone', value: '+79001112233', public_enabled: false },
    }),
  );
  await joinVisible(member, event.id);

  const viewer = await login('v3-dir2-viewer', { interests: ['ai-ml'] });
  await joinVisible(viewer, event.id);

  const res = await directory(viewer, event.id);
  const body = (await res.json()) as { members: Record<string, unknown>[] };
  const entry = body.members.find((m) => m.profile_id === member.profileId)!;
  assert.deepEqual(entry.offer_intents, ['open-to-cofound'], 'profile value used when the membership has no override');
  assert.deepEqual(entry.interests, ['ai-ml']);
  assert.equal('keywords' in entry, false, 'free-form keywords are not part of the directory projection');
  const raw = JSON.stringify(body);
  assert.equal(raw.includes('секретный'), false);
  assert.equal(raw.includes('79001112233'), false);
});

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

test('recommendations: v3 intent match comes with a localized reason, legacy tag matches follow', async () => {
  const org = await login('v3-rec-org');
  const event = await createEvent(org.cookie);

  const viewer = await login('v3-rec-viewer', {
    need_intents: ['seeking-cofounder'],
    need_tags: ['frontend'],
    offer_tags: ['mentoring'],
    interests: ['ai-ml'],
  });
  const cofounder = await login('v3-rec-cofounder', {
    offer_intents: ['open-to-cofound'],
    interests: ['ai-ml', 'startups'],
  });
  // Legacy-only candidate: mutually complementary tags, no v3 data at all.
  const legacy = await login('v3-rec-legacy', { offer_tags: ['frontend'], need_tags: ['mentoring'] });

  for (const u of [viewer, cofounder, legacy]) await joinVisible(u, event.id);

  const res = await recommendations(viewer, event.id, 'ru');
  assertStatus(res, 200);
  const body = (await res.json()) as {
    recommendations: { profile_id: string; score: number; reasons_for_me: string[]; algorithm: string }[];
  };
  assert.equal(body.recommendations[0]!.profile_id, cofounder.profileId, 'v3 match ranks first');
  assert.equal(body.recommendations[0]!.algorithm, 'welcome_intent_interest_v1');
  assert.ok(
    body.recommendations[0]!.reasons_for_me.some((r) => r.includes('со-фаундера')),
    `expected a co-founder reason, got ${JSON.stringify(body.recommendations[0]!.reasons_for_me)}`,
  );

  const legacyItem = body.recommendations.find((r) => r.profile_id === legacy.profileId);
  assert.ok(legacyItem, 'the legacy tag pair is still recommended');
  assert.equal(legacyItem!.algorithm, 'welcome_mutual_tags_v1');
  assert.deepEqual(legacyItem!.reasons_for_me, ['frontend']);
});

test('recommendations: EN locale reasons when the viewer prefers English', async () => {
  const org = await login('v3-rec-en-org');
  const event = await createEvent(org.cookie);
  const viewer = await login('v3-rec-en-viewer', { need_intents: ['seeking-cofounder'] });
  const cofounder = await login('v3-rec-en-cofounder', { offer_intents: ['open-to-cofound'] });
  await joinVisible(viewer, event.id);
  await joinVisible(cofounder, event.id);

  const res = await recommendationsRoute(
    makeRequest(`/api/events/${event.id}/recommendations`, { cookie: `${viewer.cookie}; welcome_locale=en` }),
    { params: Promise.resolve({ eventIdOrSlug: event.id }) },
  );
  const body = (await res.json()) as { recommendations: { reasons_for_me: string[] }[] };
  assert.ok(body.recommendations[0]!.reasons_for_me.some((r) => r.includes('co-founder')));
});

test('recommendations: membership overrides win over profile values for the v3 axes', async () => {
  const org = await login('v3-rec-ovr-org');
  const event = await createEvent(org.cookie);
  const viewer = await login('v3-rec-ovr-viewer', { need_intents: ['seeking-venue'] });
  const candidate = await login('v3-rec-ovr-cand', { offer_intents: ['offering-venue'] });
  await joinVisible(viewer, event.id);
  await joinVisible(candidate, event.id);

  // The membership overrides the profile's offer with the venue intent.
  const mid = await membershipId(candidate.profileId, event.id);
  const patch = await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${mid}`, {
      body: { directory_visible: true, offer_intents: ['open-to-cofound'], interests: ['skincare'] },
      cookie: candidate.cookie,
    }),
    { params: Promise.resolve({ membershipId: mid }) },
  );
  assertStatus(patch, 200);
  const patched = (await patch.json()) as { membership: Record<string, unknown> };
  assert.deepEqual(patched.membership.offer_intents, ['open-to-cofound']);
  assert.deepEqual(patched.membership.interests, ['skincare']);

  // The override replaces the profile offer → the venue pair no longer matches.
  const res = await recommendations(viewer, event.id);
  const body = (await res.json()) as { recommendations: { profile_id: string }[] };
  assert.equal(body.recommendations.some((r) => r.profile_id === candidate.profileId), false);
});

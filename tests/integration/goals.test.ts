import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
// tsx compiles page.tsx JSX with the classic transform — provide the React global
(globalThis as unknown as { React: unknown }).React = React;
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { GET as getProfileRoute, POST as saveProfileRoute } from '../../src/app/api/me/profile/route';
import { GET as publicProfile } from '../../src/app/api/public/profiles/[slug]/route';
import { GET as publicVCard } from '../../src/app/api/public/profiles/[slug]/vcard/route';
import { GET as taxonomyRoute } from '../../src/app/api/taxonomy/route';
import { POST as exportRoute } from '../../src/app/api/me/export/route';
import PublicProfilePage from '../../src/app/p/[slug]/page';
import { getSql, closeSql } from '../../src/lib/db';
import { GOAL_IDS, MAX_GOALS } from '../../src/domain/goals';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus } from './helpers';

/**
 * Profile goals (migration 011, matching v4 §B2): stored on the profile,
 * ordered by priority — and PRIVATE. The last two tests are the ones that
 * matter: a goal must never appear in the public card, the vCard or the API.
 */

after(async () => {
  await closeSql();
});

async function newProfile(prefix: string, goals?: unknown): Promise<{ cookie: string; slug: string }> {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail(prefix));
  const body: Record<string, unknown> = { display_name: `Goals ${prefix}` };
  if (goals !== undefined) body['goals'] = goals;
  const res = await saveProfileRoute(makeRequest('/api/me/profile', { body, cookie }));
  assertStatus(res, 200);
  const payload = (await res.json()) as { profile: { public_slug: string } };
  return { cookie, slug: payload.profile.public_slug };
}

async function saveGoals(cookie: string, goals: unknown): Promise<Response> {
  const current = await getProfileRoute(makeRequest('/api/me/profile', { cookie }));
  assertStatus(current, 200);
  const { profile } = (await current.json()) as { profile: { revision: number; display_name: string } };
  return saveProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: profile.display_name, revision: profile.revision, goals },
      cookie,
    }),
  );
}

async function readGoals(cookie: string): Promise<string[]> {
  const res = await getProfileRoute(makeRequest('/api/me/profile', { cookie }));
  assertStatus(res, 200);
  const { profile } = (await res.json()) as { profile: { goals: string[] } };
  return profile.goals;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('migrations 011: profiles.goals is a NOT NULL text[] defaulting to {} with a GIN index', async () => {
  const sql = getSql();
  const cols = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
    SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_name = 'profiles' AND column_name = 'goals'
  `;
  assert.equal(cols.length, 1, 'profiles.goals must exist (migration 011)');
  assert.equal(cols[0]?.data_type, 'ARRAY');
  assert.equal(cols[0]?.is_nullable, 'NO');
  assert.equal(cols[0]?.column_default, "'{}'::text[]");

  const indexes = await sql<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes WHERE tablename = 'profiles' AND indexname = 'profiles_goals_gin'
  `;
  assert.equal(indexes.length, 1, 'profiles_goals_gin must exist');
  assert.match(indexes[0]!.indexdef, /USING gin/);

  // PRIVACY: goals are per-profile and are deliberately NOT mirrored on
  // event_memberships (there is no per-event override for them).
  const membershipCols = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'event_memberships' AND column_name = 'goals'
  `;
  assert.equal(membershipCols.length, 0, 'event_memberships must not carry goals');
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

test('goals: POST stores them in priority order and GET returns the same order', async () => {
  const { cookie } = await newProfile('goals-order', ['fundraise', 'hire', 'find-mentor']);
  assert.deepEqual(await readGoals(cookie), ['fundraise', 'hire', 'find-mentor']);
});

test('goals: a duplicate collapses to its first position (priority is the array order)', async () => {
  const { cookie } = await newProfile('goals-dedupe', ['hire', 'fundraise', 'hire']);
  assert.deepEqual(await readGoals(cookie), ['hire', 'fundraise']);
});

test('goals: a fourth goal and an unknown id are rejected with 400', async () => {
  const { cookie } = await newProfile('goals-limits');

  const tooMany = await saveGoals(cookie, ['fundraise', 'hire', 'find-mentor', 'invest']);
  assertStatus(tooMany, 400);
  assert.equal(((await tooMany.json()) as { code: string }).code, 'invalid_goals');

  const unknown = await saveGoals(cookie, ['be-a-unicorn']);
  assertStatus(unknown, 400);
  assert.equal(((await unknown.json()) as { code: string }).code, 'invalid_goals');

  // The rejected writes left the stored list untouched.
  assert.deepEqual(await readGoals(cookie), []);
  assert.equal(MAX_GOALS, 3);
});

test('goals: omitting the field clears the stored list (absent = no goals)', async () => {
  const { cookie } = await newProfile('goals-clear', ['grow-network']);
  assert.deepEqual(await readGoals(cookie), ['grow-network']);
  const res = await saveGoals(cookie, null);
  assertStatus(res, 200);
  assert.deepEqual(await readGoals(cookie), []);
});

// ---------------------------------------------------------------------------
// Privacy — the reason goals live on profiles and nowhere else
// ---------------------------------------------------------------------------

test('goals are private: absent from the public JSON, the vCard and the card HTML', async () => {
  const { slug } = await newProfile('goals-private', ['fundraise', 'enter-market']);
  const marker = 'fundraise';

  const json = await publicProfile(makeRequest(`/api/public/profiles/${slug}`), {
    params: Promise.resolve({ slug }),
  });
  assertStatus(json, 200);
  const body = (await json.json()) as Record<string, unknown>;
  assert.equal('goals' in body, false, 'the public projection must not carry goals');
  assert.equal(JSON.stringify(body).includes(marker), false);

  const vcard = await publicVCard(makeRequest(`/api/public/profiles/${slug}/vcard`), {
    params: Promise.resolve({ slug }),
  });
  assertStatus(vcard, 200);
  const card = await vcard.text();
  assert.equal(card.includes(marker), false);
  assert.equal(/^X-WELCOME-GOAL/m.test(card), false, 'no goal property may be added to the vCard');

  const element = await PublicProfilePage({ params: Promise.resolve({ slug }) });
  const html = renderToStaticMarkup(element);
  assert.equal(html.includes(marker), false, 'the public card must not render goals');
  assert.equal(html.includes('goals-picker'), false);
});

test('goals: the data-subject export carries them (private data is still the owner\'s)', async () => {
  const { cookie } = await newProfile('goals-export', ['get-more-clients', 'find-community']);
  const res = await exportRoute(makeRequest('/api/me/export', { method: 'POST', body: {}, cookie }));
  assertStatus(res, 200);
  const payload = (await res.json()) as { profile: { goals: string[]; hidden_fields: string[] } };
  assert.deepEqual(payload.profile.goals, ['get-more-clients', 'find-community']);
  assert.ok(Array.isArray(payload.profile.hidden_fields), 'card opt-outs belong in the export too');
});

test('goals: GET /api/taxonomy stays v3 and gains goals + limits.goals', async () => {
  const res = await taxonomyRoute();
  assertStatus(res, 200);
  const body = (await res.json()) as {
    version: string;
    limits: Record<string, number>;
    goals: { id: string; label: Record<string, string> }[];
    intents: unknown[];
    interests: unknown[];
  };
  assert.equal(body.version, 'v3', 'the catalogue version must not change');
  assert.equal(body.limits['goals'], MAX_GOALS);
  assert.deepEqual(
    body.goals.map((g) => g.id),
    [...GOAL_IDS],
  );
  assert.deepEqual(Object.keys(body.goals[0]!.label).sort(), ['en', 'es', 'ru']);
  // The pre-existing payload is untouched.
  assert.equal(body.intents.length, 16);
  assert.ok(body.interests.length > 0);
  assert.equal(body.limits['need_intents'], 3);
  assert.equal(body.limits['interests'], 5);
});

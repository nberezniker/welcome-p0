import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as otpRequest } from '../../src/app/api/auth/otp/request/route';
import { POST as otpVerify } from '../../src/app/api/auth/otp/verify/route';
import { POST as upsertProfile } from '../../src/app/api/me/profile/route';
import { GET as publicProfile } from '../../src/app/api/public/profiles/[slug]/route';
import { makeRequest, uniqueEmail, loginViaOtp, assertStatus } from './helpers';
import { getSql, closeSql } from '../../src/lib/db';

/**
 * AC-10 — duplicate people must not become one person.
 *
 * The criterion ("дублирующее имя/LinkedIn URL → не объединять accounts") is
 * about what the system does NOT do. Two things are therefore asserted as
 * behaviour, not as documentation:
 *
 *   1. A display name is not an identity. Two people whose cards say the same
 *      name keep two separate cards on two separate URLs, and creating the
 *      second one leaves the first row byte-for-byte untouched — there is no
 *      auto-merge step anywhere in the profile paths (nothing in the create/update
 *      flow reads another account's profile, so nothing can merge them).
 *   2. A URL IS an identity. `profiles.public_slug` is UNIQUE, so a duplicate
 *      slug attempt (SQL or API) cannot produce two rows pointing at one card:
 *      one URL keeps serving one person, and the failure is loud (23505) rather
 *      than a silent second owner.
 */

after(async () => {
  await closeSql();
});

interface ProfileRow {
  id: string;
  account_id: string;
  public_slug: string;
  display_name: string;
  headline: string | null;
  revision: number;
  updated_at: string;
}

interface Created {
  account_id: string;
  profile_id: string;
  slug: string;
  cookie: string;
}

async function createProfile(prefix: string, displayName: string, headline: string): Promise<Created> {
  const cookie = await loginViaOtp(otpRequest, otpVerify, uniqueEmail(prefix));
  const res = await upsertProfile(
    makeRequest('/api/me/profile', { cookie, body: { display_name: displayName, headline } }),
  );
  assertStatus(res, 200);
  const body = (await res.json()) as { profile: { public_slug: string } };
  const sql = getSql();
  const rows = await sql<{ id: string; account_id: string }[]>`
    SELECT p.id, p.account_id FROM profiles p WHERE p.public_slug = ${body.profile.public_slug}
  `;
  assert.equal(rows.length, 1, 'the created slug must belong to exactly one row');
  return { account_id: rows[0]!.account_id, profile_id: rows[0]!.id, slug: body.profile.public_slug, cookie };
}

async function profileBySlug(slug: string): Promise<ProfileRow> {
  const rows = await getSql()<ProfileRow[]>`
    SELECT id, account_id, public_slug, display_name, headline, revision::int AS revision, updated_at::text AS updated_at
    FROM profiles WHERE public_slug = ${slug}
  `;
  assert.equal(rows.length, 1, `expected exactly one profile for slug ${slug}`);
  return rows[0]!;
}

/** The public projection as an anonymous visitor sees it (no session, no cookie). */
async function publicCard(slug: string): Promise<Record<string, unknown>> {
  const res = await publicProfile(
    makeRequest(`/api/public/profiles/${slug}`),
    { params: Promise.resolve({ slug }) },
  );
  assertStatus(res, 200);
  return (await res.json()) as Record<string, unknown>;
}

test('AC-10: two accounts may share a display name — two cards, two URLs, and no merge of any kind', async () => {
  const SHARED_NAME = 'Иван Петров';
  const a = await createProfile('dup-a', SHARED_NAME, 'CTO at Alpha');
  const beforeB = await profileBySlug(a.slug);

  const b = await createProfile('dup-b', SHARED_NAME, 'Designer at Beta');

  // 1. Two people, two rows, two URLs — the name is identical, the identity is not.
  assert.notEqual(a.profile_id, b.profile_id);
  assert.notEqual(a.account_id, b.account_id);
  assert.notEqual(a.slug, b.slug, 'a shared display name must not share a URL');
  const afterB = await profileBySlug(b.slug);
  assert.equal(afterB.display_name, SHARED_NAME);
  assert.equal(beforeB.display_name, SHARED_NAME);

  // 2. No auto-merge: registering the second person changed NOTHING about the
  //    first — same row id, same slug, same revision, same updated_at. (A merge
  //    implemented as "adopt the other profile" would move at least one of these.)
  const afterA = await profileBySlug(a.slug);
  assert.deepEqual(afterA, beforeB, 'the first person\'s profile must be untouched by the second');

  // 3. Each URL resolves to its own owner, and to nobody else.
  const cardA = await publicCard(a.slug);
  const cardB = await publicCard(b.slug);
  assert.equal(cardA.display_name, SHARED_NAME);
  assert.equal(cardB.display_name, SHARED_NAME);
  assert.equal(cardA.headline, 'CTO at Alpha');
  assert.equal(cardB.headline, 'Designer at Beta');
  assert.notEqual(cardA.slug, cardB.slug);
  assert.equal(JSON.stringify(cardA).includes(b.profile_id), false, 'card A must not point at profile B');
  assert.equal(JSON.stringify(cardB).includes(a.profile_id), false, 'card B must not point at profile A');

  // 4. One card per account: the UNIQUE(account_id) constraint is the second half
  //    of the rule above. A direct second profile for the SAME account is refused
  //    (dup-slug or not), so "duplicate profile" cannot be manufactured either.
  const sql = getSql();
  await assert.rejects(
    () => sql`
      INSERT INTO profiles (account_id, public_slug, display_name)
      VALUES (${a.account_id}, ${'dup-second-card-' + a.slug}, 'Иван Двойной')
    `,
    (err: unknown) => (err as { code?: string }).code === '23505',
    'a second profile row for one account must be refused by UNIQUE(account_id)',
  );
  const owned = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM profiles WHERE account_id = ${a.account_id}
  `;
  assert.equal(owned[0]!.n, 1, 'the account still owns exactly one profile');
});

test('AC-10: a duplicate public slug cannot create two rows — the URL keeps its owner', async () => {
  const owner = await createProfile('dup-owner', 'Owner Person', 'Owner headline');
  const other = await createProfile('dup-other', 'Owner Person', 'Other headline');

  // The shape a real collision would take: a second profile row asking for a slug
  // that is already taken (the API never lets a client choose a slug; this is the
  // DB-level guarantee behind that).
  const sql = getSql();
  await assert.rejects(
    () => sql`
      INSERT INTO profiles (account_id, public_slug, display_name)
      VALUES (${other.account_id}, ${owner.slug}, 'Owner Person Clone')
    `,
    (err: unknown) => (err as { code?: string }).code === '23505',
    'UNIQUE(public_slug) must refuse the duplicate',
  );

  // The failed attempt left nothing behind: one row, one URL, one owner.
  const rows = await sql<{ account_id: string }[]>`SELECT account_id FROM profiles WHERE public_slug = ${owner.slug}`;
  assert.equal(rows.length, 1, 'exactly one row may point at a public URL');
  assert.equal(rows[0]!.account_id, owner.account_id, 'the URL still belongs to its original owner');
  assert.equal((await publicCard(owner.slug)).headline, 'Owner headline');

  // And the API cannot be talked into a chosen slug at all: `public_slug` in the
  // request body is not part of the profile input, so the card is created under a
  // generated slug and the victim's URL is untouched.
  const third = await loginViaOtp(otpRequest, otpVerify, uniqueEmail('dup-squatter'));
  const squat = await upsertProfile(
    makeRequest('/api/me/profile', {
      cookie: third,
      body: { display_name: 'Owner Person', headline: 'Squatter', public_slug: owner.slug, slug: owner.slug },
    }),
  );
  assertStatus(squat, 200);
  const squatted = (await squat.json()) as { profile: { public_slug: string } };
  assert.notEqual(squatted.profile.public_slug, owner.slug, 'a client may not choose the public slug');
  assert.match(squatted.profile.public_slug, /^[A-Za-z0-9_-]{22}$/);
  const after = await sql<{ account_id: string }[]>`SELECT account_id FROM profiles WHERE public_slug = ${owner.slug}`;
  assert.equal(after.length, 1, 'the requested URL still has exactly one owner');
  assert.equal(after[0]!.account_id, owner.account_id);
});

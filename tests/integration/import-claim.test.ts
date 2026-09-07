import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as importsRoute } from '../../src/app/api/events/[eventIdOrSlug]/imports/route';
import { POST as inviteRoute } from '../../src/app/api/organizer/events/[eventId]/registrations/[registrationId]/invite/route';
import { POST as claimRoute } from '../../src/app/api/registration-claims/route';
import { loadClaimPreview } from '../../src/lib/claim';
import { getSql, closeSql } from '../../src/lib/db';
import { emailLookupHash } from '../../src/lib/crypto';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

const HASH_PEPPER = 'integration-test-pepper-0123456789abcdef';

after(async () => {
  await closeSql();
});

async function login(prefix: string, withProfile = true): Promise<{ cookie: string; accountId: string; email: string }> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  if (withProfile) {
    const res = await createProfileRoute(
      makeRequest('/api/me/profile', { body: { display_name: `User ${prefix}` }, cookie }),
    );
    assertStatus(res, 200);
  }
  return { cookie, accountId, email };
}

async function createEvent(cookie: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'Import Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC', ...overrides },
      cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string; slug: string } }).event;
}

function csvEvent(): string {
  return [
    'name,email,company,role,external_id,approval_status',
    'Alice Sample,alice.sample@example.org,Acme,Engineer,g-1,approved',
    'Bob Sample,bob.sample@example.org,Glob,Designer,g-2,unknown',
    'Quarantined Guy,quarantine.sample@example.org,Evil,Spam,g-3,maybe',
  ].join('\n');
}

async function importCsv(cookie: string, eventId: string, csvText: string, mode: 'preview' | 'commit'): Promise<Response> {
  return importsRoute(
    makeRequest(`/api/events/${eventId}/imports`, { body: { csv_text: csvText, mode }, cookie }),
    { params: Promise.resolve({ eventIdOrSlug: eventId }) },
  );
}

async function invite(cookie: string, eventId: string, registrationId: string): Promise<Response> {
  return inviteRoute(
    makeRequest(`/api/organizer/events/${eventId}/registrations/${registrationId}/invite`, { body: {}, cookie }),
    { params: Promise.resolve({ eventId, registrationId }) },
  );
}

async function claim(cookie: string, token: string): Promise<Response> {
  return claimRoute(makeRequest('/api/registration-claims', { body: { token }, cookie }));
}

function tokenFromClaimUrl(claimUrl: string): string {
  return claimUrl.split('/claim/')[1]!;
}

async function registrationByEmail(eventId: string, email: string): Promise<{
  id: string; claim_state: string; approval_status: string; import_revision: number;
}> {
  const sql = getSql();
  const hash = emailLookupHash(email, HASH_PEPPER);
  const rows = await sql<{ id: string; claim_state: string; approval_status: string; import_revision: number }[]>`
    SELECT id, claim_state, approval_status, import_revision::int AS import_revision
    FROM registrations WHERE event_id = ${eventId} AND email_lookup_hash = ${hash}
  `;
  return rows[0]!;
}

test('import: preview creates NO registrations; commit creates rows', async () => {
  const { cookie } = await login('imp-org');
  const e = await createEvent(cookie);

  const preview = await importCsv(cookie, e.id, csvEvent(), 'preview');
  assertStatus(preview, 200);
  const previewBody = (await preview.json()) as { preview: { totalRows: number; quarantined: number; validEmails: number; sample: unknown[] } };
  assert.equal(previewBody.preview.totalRows, 3);
  assert.equal(previewBody.preview.quarantined, 1);
  assert.equal(previewBody.preview.validEmails, 3);
  assert.ok(previewBody.preview.sample.length <= 50);

  const sql = getSql();
  const before = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM registrations WHERE event_id = ${e.id}`;
  assert.equal(before[0]?.count, 0, 'preview must not write');

  const commit = await importCsv(cookie, e.id, csvEvent(), 'commit');
  assertStatus(commit, 200);
  const commitBody = (await commit.json()) as { counts: { created: number; updated: number } };
  assert.equal(commitBody.counts.created, 3);
  assert.equal(commitBody.counts.updated, 0);

  const q = await registrationByEmail(e.id, 'quarantine.sample@example.org');
  assert.equal(q.approval_status, 'quarantined');
});

test('import: import creates NO accounts and NO profiles (registrations only)', async () => {
  const { cookie } = await login('imp-noacc');
  const e = await createEvent(cookie);
  const sql = getSql();
  // Parallel test files share the DB — scope the assertion to the imported emails.
  const emails = ['alice.sample@example.org', 'bob.sample@example.org', 'quarantine.sample@example.org'];
  const hashes = emails.map((em) => emailLookupHash(em, HASH_PEPPER));
  const accountsBefore = (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts WHERE email_lookup_hash = ANY(${hashes})`)[0]!.count;
  const profilesBefore = (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM profiles WHERE public_slug = 'no-import-profiles'`)[0]!.count;

  await importCsv(cookie, e.id, csvEvent(), 'commit');

  const accountsAfter = (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM accounts WHERE email_lookup_hash = ANY(${hashes})`)[0]!.count;
  const profilesAfter = (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM profiles WHERE public_slug = 'no-import-profiles'`)[0]!.count;
  assert.equal(accountsBefore, 0, 'import must not create accounts for imported emails');
  assert.equal(accountsAfter, 0, 'import must not create accounts for imported emails');
  assert.equal(profilesBefore, 0);
  assert.equal(profilesAfter, 0);
});

test('import: AC-17 — re-import is idempotent (same rows, revision++)', async () => {
  const { cookie } = await login('imp-re');
  const e = await createEvent(cookie);
  await importCsv(cookie, e.id, csvEvent(), 'commit');

  const changed = csvEvent().replace('Alice Sample,alice.sample@example.org,Acme', 'Alice Updated,alice.sample@example.org,Acme2');
  const second = await importCsv(cookie, e.id, changed, 'commit');
  assertStatus(second, 200);
  const body = (await second.json()) as { counts: { created: number; updated: number } };
  assert.equal(body.counts.created, 0);
  assert.equal(body.counts.updated, 3);

  const sql = getSql();
  const count = (await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM registrations WHERE event_id = ${e.id}`)[0]!.count;
  assert.equal(count, 3, 're-import must not duplicate');

  const alice = await registrationByEmail(e.id, 'alice.sample@example.org');
  assert.equal(alice.import_revision, 2);
  const name = await sql<{ imported_name: string | null }[]>`SELECT imported_name FROM registrations WHERE id = ${alice.id}`;
  assert.equal(name[0]?.imported_name, 'Alice Updated');
});

test('import: AC-19 — 6000 rows rejected with 413; formula cell stored as data', async () => {
  const { cookie } = await login('imp-limit');
  const e = await createEvent(cookie);

  const lines = ['name,email'];
  for (let i = 0; i < 6000; i++) lines.push(`P ${i},p${i}@example.org`);
  const tooBig = await importCsv(cookie, e.id, lines.join('\n'), 'commit');
  assertStatus(tooBig, 413);
  const errBody = (await tooBig.json()) as { code: string };
  assert.equal(errBody.code, 'payload_too_large');

  const formula = "name,email,notes\nHal,hal@example.org,=cmd|' /C mspaint'";
  const ok = await importCsv(cookie, e.id, formula, 'commit');
  assertStatus(ok, 200);
  const sql = getSql();
  const data = await sql<{ imported_data: Record<string, string> }[]>`
    SELECT imported_data FROM registrations WHERE event_id = ${e.id}
  `;
  assert.equal(data[0]?.imported_data['notes'], "=cmd|' /C mspaint'");
});

test('import: non-organizer → 403', async () => {
  const { cookie: org } = await login('imp-owner');
  const { cookie: stranger } = await login('imp-stranger');
  const e = await createEvent(org);
  const res = await importCsv(stranger, e.id, csvEvent(), 'commit');
  assertStatus(res, 403);
});

test('invite: owner gets one-time unbound challenge; non-owner → 403; quarantined → 403', async () => {
  const { cookie: org } = await login('inv-org');
  const { cookie: stranger } = await login('inv-stranger');
  const e = await createEvent(org);
  await importCsv(org, e.id, csvEvent(), 'commit');
  const alice = await registrationByEmail(e.id, 'alice.sample@example.org');
  const q = await registrationByEmail(e.id, 'quarantine.sample@example.org');

  assertStatus(await invite(stranger, e.id, alice.id), 403);
  assertStatus(await invite(org, e.id, q.id), 403); // quarantined cannot be invited

  const res = await invite(org, e.id, alice.id);
  assertStatus(res, 200);
  const body = (await res.json()) as { claim_url: string; expires_at: string };
  assert.ok(body.claim_url.startsWith('/claim/'));
  assert.ok(body.claim_url.includes(tokenFromClaimUrl(body.claim_url)));

  const sql = getSql();
  const rows = await sql<{ account_id: string | null; purpose: string; consumed_at: Date | null; registration_id: string | null }[]>`
    SELECT account_id, purpose, consumed_at, registration_id
    FROM link_challenges WHERE registration_id = ${alice.id} AND purpose = 'registration_claim'
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.account_id, null, 'claim challenge must not be pre-bound to an account');
  assert.equal(rows[0]?.consumed_at, null);
  assert.equal(rows[0]?.registration_id, alice.id);
});

test('claim: AC-07 — preview does not consume the challenge', async () => {
  const { cookie: org } = await login('claim-get-org');
  const e = await createEvent(org);
  await importCsv(org, e.id, 'name,email\nGet Person,get.person@example.org', 'commit');
  const reg = await registrationByEmail(e.id, 'get.person@example.org');
  const res = await invite(org, e.id, reg.id);
  const token = tokenFromClaimUrl(((await res.json()) as { claim_url: string }).claim_url);

  const view = await loadClaimPreview(getSql(), token);
  assert.ok(view, 'preview must resolve');
  assert.equal(view!.event.name, 'Import Meetup');
  assert.equal(view!.alreadyClaimed, false);

  const sql = getSql();
  const rows = await sql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM link_challenges WHERE registration_id = ${reg.id} AND purpose = 'registration_claim'
  `;
  assert.equal(rows[0]?.consumed_at, null, 'GET/preview must not consume the token');
});

test('claim: AC-08 cross-email → 403; success path binds matching email; AC-09 replay → 409', async () => {
  const { cookie: org } = await login('claim-org');
  const e = await createEvent(org);
  await importCsv(org, e.id, csvEvent(), 'commit');
  const aliceReg = await registrationByEmail(e.id, 'alice.sample@example.org');
  const res = await invite(org, e.id, aliceReg.id);
  const token = tokenFromClaimUrl(((await res.json()) as { claim_url: string }).claim_url);

  // AC-08: a different user tries to use Alice's token.
  const bobEmail = uniqueEmail('claim-bob');
  const bobCookie = await loginViaOtp(requestOtp, verifyOtp, bobEmail);
  assertStatus(await claim(bobCookie, token), 403);
  const sql = getSql();
  const stillUnclaimed = await sql<{ claim_state: string }[]>`SELECT claim_state FROM registrations WHERE id = ${aliceReg.id}`;
  assert.equal(stillUnclaimed[0]?.claim_state, 'unclaimed');

  // The matching user claims; profile created from imported_name.
  const aliceCookie = await loginViaOtp(requestOtp, verifyOtp, 'alice.sample@example.org');
  const ok = await claim(aliceCookie, token);
  assertStatus(ok, 200);
  const okBody = (await ok.json()) as { profile_created: boolean; notice: string; membership: { state: string; directory_visible: boolean }; event_id: string };
  assert.equal(okBody.profile_created, true);
  assert.equal(okBody.membership.state, 'active');
  assert.equal(okBody.membership.directory_visible, false);
  assert.match(okBody.notice, /проверьте|verify/i);
  assert.equal(okBody.event_id, e.id);

  const prof = await sql<{ display_name: string }[]>`
    SELECT p.display_name FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE a.email_lookup_hash = ${emailLookupHash('alice.sample@example.org', HASH_PEPPER)}
  `;
  assert.equal(prof[0]?.display_name, 'Alice Sample');

  // AC-09: replaying the token → 409 already_used.
  const replay = await claim(aliceCookie, token);
  assertStatus(replay, 409);
  assert.equal(((await replay.json()) as { code: string }).code, 'already_used');
});

test('claim: AC-18 — existing profile is NOT overwritten by import data', async () => {
  const { cookie: org } = await login('claim18-org');
  const e = await createEvent(org);
  await importCsv(org, e.id, 'name,email\nExisting Person,existing.person@example.org', 'commit');
  const reg = await registrationByEmail(e.id, 'existing.person@example.org');
  const res = await invite(org, e.id, reg.id);
  const token = tokenFromClaimUrl(((await res.json()) as { claim_url: string }).claim_url);

  const cookie = await loginViaOtp(requestOtp, verifyOtp, 'existing.person@example.org');
  const profRes = await createProfileRoute(
    makeRequest('/api/me/profile', { body: { display_name: 'My Chosen Name' }, cookie }),
  );
  assertStatus(profRes, 200);
  const slugBefore = ((await profRes.json()) as { profile: { public_slug: string } }).profile.public_slug;

  const ok = await claim(cookie, token);
  assertStatus(ok, 200);
  assert.equal(((await ok.json()) as { profile_created: boolean }).profile_created, false);

  const sql = getSql();
  const rows = await sql<{ display_name: string; public_slug: string }[]>`
    SELECT p.display_name, p.public_slug FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE a.email_lookup_hash = ${emailLookupHash('existing.person@example.org', HASH_PEPPER)}
  `;
  assert.equal(rows[0]?.display_name, 'My Chosen Name', 'import data must not overwrite the chosen profile');
  assert.equal(rows[0]?.public_slug, slugBefore);
});

test('claim: unknown token → 404; expired token → 410; anonymous → 401', async () => {
  const { cookie: org } = await login('claim-neg-org');
  const e = await createEvent(org);
  await importCsv(org, e.id, 'name,email\nExp Person,exp.person@example.org', 'commit');
  const reg = await registrationByEmail(e.id, 'exp.person@example.org');
  const res = await invite(org, e.id, reg.id);
  const token = tokenFromClaimUrl(((await res.json()) as { claim_url: string }).claim_url);

  const anon = await claim('welcome_session=none', token);
  assertStatus(anon, 401);

  const sql = getSql();
  await sql`UPDATE link_challenges SET expires_at = now() - interval '1 minute' WHERE registration_id = ${reg.id} AND purpose = 'registration_claim'`;
  const userCookie = await loginViaOtp(requestOtp, verifyOtp, 'exp.person@example.org');
  const expired = await claim(userCookie, token);
  assertStatus(expired, 410);
  assert.equal(((await expired.json()) as { code: string }).code, 'expired');

  const unknown = await claim(userCookie, 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRva2Vu'); // base64url junk
  assertStatus(unknown, 404);
});

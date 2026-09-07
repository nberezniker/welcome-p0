import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as postConsent } from '../../src/app/api/consents/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as settingsRoute } from '../../src/app/api/organizer/events/[eventId]/settings/route';
import { GET as getEventRoute } from '../../src/app/api/events/[eventIdOrSlug]/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { getSql, closeSql } from '../../src/lib/db';
import { requireEventRole } from '../../src/domain/organizer';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

after(async () => {
  await closeSql();
});

async function login(prefix: string): Promise<{ cookie: string; accountId: string; profileSlug: string }> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const profileRes = await createProfileRoute(
    makeRequest('/api/me/profile', { body: { display_name: `User ${prefix}`, languages: ['en'], offer_tags: ['design'], need_tags: ['frontend'] }, cookie }),
  );
  assertStatus(profileRes, 200);
  const profile = ((await profileRes.json()) as { profile: { slug: string } }).profile;
  return { cookie, accountId, profileSlug: profile.slug };
}

async function createEvent(cookie: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: {
        name: 'Test Meetup',
        mode: 'offline',
        access_mode: 'public',
        timezone: 'Europe/Madrid',
        ...overrides,
      },
      cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string; slug: string } }).event;
}

async function join(cookie: string, idOrSlug: string, body: Record<string, unknown> = {}): Promise<Response> {
  return joinRoute(makeRequest(`/api/events/${idOrSlug}/join`, { body, cookie }), {
    params: Promise.resolve({ eventIdOrSlug: idOrSlug }),
  });
}

test('events: organizer creates event → owner member row + audit', async () => {
  const { cookie, accountId } = await login('org-create');
  const event = await createEvent(cookie, { name: 'Owner Check Meetup' });

  const sql = getSql();
  const owner = await sql<{ role: string }[]>`
    SELECT om.role FROM organizer_members om
    JOIN events e ON e.organizer_id = om.organizer_id
    WHERE e.id = ${event.id} AND om.account_id = ${accountId}
  `;
  assert.equal(owner[0]?.role, 'owner');

  const audit = await sql<{ id: number }[]>`
    SELECT id FROM audit_events WHERE action = 'event.created' AND target_id = ${event.id}
  `;
  assert.equal(audit.length, 1);
});

test('events: timezone validation rejects non-IANA values with 400', async () => {
  const { cookie } = await login('org-tz');
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'X', mode: 'offline', access_mode: 'public', timezone: 'Mars/Olympus' },
      cookie,
    }),
  );
  assertStatus(res, 400);
});

test('events: ends_at before starts_at → 400', async () => {
  const { cookie } = await login('org-dates');
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: {
        name: 'X', mode: 'offline', access_mode: 'public', timezone: 'UTC',
        starts_at: '2026-10-01T18:00:00Z', ends_at: '2026-10-01T17:00:00Z',
      },
      cookie,
    }),
  );
  assertStatus(res, 400);
});

test('events: AC-14 — one profile joins two events (two memberships)', async () => {
  const { cookie, accountId } = await login('ac14');
  const e1 = await createEvent(cookie);
  const e2 = await createEvent(cookie, { name: 'Second Meetup', slug: undefined });

  assertStatus(await join(cookie, e1.id), 200);
  assertStatus(await join(cookie, e2.id), 200);

  const sql = getSql();
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM event_memberships m
    JOIN profiles p ON p.id = m.profile_id
    WHERE p.account_id = ${accountId}
  `;
  assert.equal(rows[0]?.count, 2);
});

test('events: AC-24 — join creates ZERO consent rows (no implicit marketing opt-in)', async () => {
  const { cookie, accountId } = await login('ac24');
  const e = await createEvent(cookie);
  assertStatus(await join(cookie, e.id), 200);

  const sql = getSql();
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM consent_events WHERE account_id = ${accountId}
  `;
  assert.equal(rows[0]?.count, 0);
});

test('events: re-join is idempotent (no duplicate membership)', async () => {
  const { cookie, accountId } = await login('rejoin');
  const e = await createEvent(cookie);

  const first = await join(cookie, e.id);
  assertStatus(first, 200);
  const second = await join(cookie, e.id);
  assertStatus(second, 200);

  const sql = getSql();
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM event_memberships m
    JOIN profiles p ON p.id = m.profile_id
    WHERE p.account_id = ${accountId} AND m.event_id = ${e.id}
  `;
  assert.equal(rows[0]?.count, 1);
});

test('events: join without a profile → 409 profile_required', async () => {
  const email = uniqueEmail('noprofile');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const { cookie: orgCookie } = await login('noprofile-org');
  const e = await createEvent(orgCookie);

  const res = await join(cookie, e.id);
  assertStatus(res, 409);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'profile_required');
});

test('events: public join works by slug; draft event → 403; registration mode without code → 403', async () => {
  const { cookie } = await login('joiner');
  const { cookie: orgCookie } = await login('join-org');

  const publicEvent = await createEvent(orgCookie);
  assertStatus(await join(cookie, publicEvent.slug), 200);

  const draft = await createEvent(orgCookie);
  const sql = getSql();
  await sql`UPDATE events SET status = 'draft' WHERE id = ${draft.id}`;
  const draftRes = await join(cookie, draft.id);
  assertStatus(draftRes, 403);

  const reg = await createEvent(orgCookie, { name: 'Reg Event', access_mode: 'registration' });
  const regRes = await join(cookie, reg.id);
  assertStatus(regRes, 403);
  const regBody = (await regRes.json()) as { code: string };
  assert.equal(regBody.code, 'join_forbidden');
});

test('events: join_code path — closed event joins only with the correct code', async () => {
  const { cookie: orgCookie } = await login('code-org');
  const { cookie: memberCookie } = await login('code-member');
  const e = await createEvent(orgCookie, { name: 'Code Event', access_mode: 'closed' });

  const wrong = await join(memberCookie, e.id, { join_code: 'WRONGCODE' });
  assertStatus(wrong, 403);

  const set = await settingsRoute(
    makeRequest(`/api/organizer/events/${e.id}/settings`, { body: { join_code: 'SECRET123' }, cookie: orgCookie }),
    { params: Promise.resolve({ eventId: e.id }) },
  );
  assertStatus(set, 200);

  assertStatus(await join(memberCookie, e.id, { join_code: 'SECRET123' }), 200);
});

test('events: max_participants cap → event_full', async () => {
  const { cookie: orgCookie } = await login('cap-org');
  const { cookie: a } = await login('cap-a');
  const { cookie: b } = await login('cap-b');
  const e = await createEvent(orgCookie, { name: 'Cap Event', max_participants: 1 });

  assertStatus(await join(a, e.id), 200);
  const full = await join(b, e.id);
  assertStatus(full, 403);
  const body = (await full.json()) as { code: string };
  assert.equal(body.code, 'event_full');
});

test('events: AC-20a — online_link visible ONLY to active member', async () => {
  const { cookie: orgCookie } = await login('link-org');
  const { cookie: memberCookie } = await login('link-member');
  const { cookie: strangerCookie } = await login('link-stranger');
  const e = await createEvent(orgCookie, {
    name: 'Online Link Event', mode: 'online', online_link: 'https://meet.example.org/room-1',
  });

  // Anonymous viewer.
  const anon = await getEventRoute(makeRequest(`/api/events/${e.slug}`), { params: Promise.resolve({ eventIdOrSlug: e.slug }) });
  assertStatus(anon, 200);
  const anonBody = (await anon.json()) as { viewer: { is_member: boolean; online_link: string | null } };
  assert.equal(anonBody.viewer.is_member, false);
  assert.equal(anonBody.viewer.online_link, null);

  // Authenticated non-member.
  const stranger = await getEventRoute(makeRequest(`/api/events/${e.slug}`, { cookie: strangerCookie }), { params: Promise.resolve({ eventIdOrSlug: e.slug }) });
  const strangerBody = (await stranger.json()) as { viewer: { online_link: string | null } };
  assert.equal(strangerBody.viewer.online_link, null);

  // Member sees it; by uuid and slug.
  assertStatus(await join(memberCookie, e.id), 200);
  const member = await getEventRoute(makeRequest(`/api/events/${e.id}`, { cookie: memberCookie }), { params: Promise.resolve({ eventIdOrSlug: e.id }) });
  const memberBody = (await member.json()) as { event: { slug: string }; viewer: { is_member: boolean; online_link: string | null } };
  assert.equal(memberBody.viewer.is_member, true);
  assert.equal(memberBody.viewer.online_link, 'https://meet.example.org/room-1');
  assert.equal(memberBody.event.slug, e.slug);
});

test('events: AC-22a — another organizer gets 403 on foreign event settings', async () => {
  const { cookie: orgA } = await login('tenant-a');
  const { cookie: orgB } = await login('tenant-b');
  const e = await createEvent(orgA, { name: 'A Event' });

  const res = await settingsRoute(
    makeRequest(`/api/organizer/events/${e.id}/settings`, { body: { join_code: 'HACK' }, cookie: orgB }),
    { params: Promise.resolve({ eventId: e.id }) },
  );
  assertStatus(res, 403);
});

test('events: settings update — owner/admin only; directory_close_at + access_mode persist', async () => {
  const { cookie: orgCookie } = await login('settings-org');
  const e = await createEvent(orgCookie, { name: 'Settings Event', access_mode: 'public' });

  const res = await settingsRoute(
    makeRequest(`/api/organizer/events/${e.id}/settings`, {
      body: { access_mode: 'closed', join_code: 'NEWCODE1', directory_close_at: '2026-11-01T00:00:00Z' },
      cookie: orgCookie,
    }),
    { params: Promise.resolve({ eventId: e.id }) },
  );
  assertStatus(res, 200);

  const sql = getSql();
  const rows = await sql<{ access_mode: string; join_code: string | null; directory_close_at: Date | null }[]>`
    SELECT access_mode, join_code, directory_close_at FROM events WHERE id = ${e.id}
  `;
  assert.equal(rows[0]?.access_mode, 'closed');
  assert.equal(rows[0]?.join_code, 'NEWCODE1');
  assert.ok(rows[0]?.directory_close_at instanceof Date);

  // clear join_code
  await settingsRoute(
    makeRequest(`/api/organizer/events/${e.id}/settings`, { body: { join_code: null }, cookie: orgCookie }),
    { params: Promise.resolve({ eventId: e.id }) },
  );
  const cleared = await sql<{ join_code: string | null }[]>`SELECT join_code FROM events WHERE id = ${e.id}`;
  assert.equal(cleared[0]?.join_code, null);
});

test('events: requireEventRole — staff does not satisfy owner/admin (interpretation ⑦)', async () => {
  const { cookie: orgCookie, accountId: ownerId } = await login('role-org');
  const { accountId: staffId } = await login('role-staff');
  const e = await createEvent(orgCookie, { name: 'Role Event' });

  const sql = getSql();
  await sql`
    INSERT INTO organizer_members (organizer_id, account_id, role)
    SELECT e.organizer_id, ${staffId}, 'staff' FROM events e WHERE e.id = ${e.id}
  `;

  const asOwner = await requireEventRole(sql, ownerId, e.id, ['owner', 'admin']);
  assert.ok(asOwner, 'owner must resolve');
  const asStaffAdmin = await requireEventRole(sql, staffId, e.id, ['owner', 'admin']);
  assert.equal(asStaffAdmin, null, 'staff must not satisfy owner/admin');
  const asStaff = await requireEventRole(sql, staffId, e.id, ['staff']);
  assert.ok(asStaff, 'staff resolves for staff role check');
});

test('events: consent grant path stays independent of join (grant works after join)', async () => {
  const { cookie } = await login('consent-join');
  const e = await createEvent(cookie);
  assertStatus(await join(cookie, e.id), 200);

  const grant = await postConsent(
    makeRequest('/api/consents', {
      body: { action: 'grant', purpose: 'event_directory', scope_type: 'global', policy_version: '2026-09-07' },
      cookie,
    }),
  );
  assertStatus(grant, 200);
});

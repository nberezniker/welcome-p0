import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as settingsRoute } from '../../src/app/api/organizer/events/[eventId]/settings/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { getSql, closeSql } from '../../src/lib/db';
import { resetIpBuckets } from '../../src/lib/ratelimit';
import { hmacHex } from '../../src/lib/crypto';
import { requireHashPepper } from '../../src/lib/env';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus } from './helpers';

// ---------------------------------------------------------------------------
// F-02: join_code brute-force lock. Same client IP fires 20 wrong codes
// (the in-memory bucket is reset between requests so the DB-level window is
// what's under test), the 21st — even with the CORRECT code — hits
// 429 join_code_locked. A successful join clears the (event, ip) history.
// ---------------------------------------------------------------------------

after(async () => {
  await closeSql();
});

const LOCKED_IP = '10.77.0.1';
const CLEAN_IP = '10.77.0.2';

async function login(prefix: string): Promise<string> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const profileRes = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `User ${prefix}`, languages: ['en'], offer_tags: ['design'], need_tags: ['frontend'] },
      cookie,
    }),
  );
  assertStatus(profileRes, 200);
  return cookie;
}

async function createClosedEvent(cookie: string, code: string): Promise<{ id: string; slug: string }> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'Lockout Meetup', mode: 'offline', access_mode: 'closed', timezone: 'Europe/Madrid' },
      cookie,
    }),
  );
  assertStatus(res, 201);
  const event = ((await res.json()) as { event: { id: string; slug: string } }).event;
  const set = await settingsRoute(
    makeRequest(`/api/organizer/events/${event.id}/settings`, { body: { join_code: code }, cookie }),
    { params: Promise.resolve({ eventId: event.id }) },
  );
  assertStatus(set, 200);
  return event;
}

function joinFromIp(cookie: string, idOrSlug: string, body: Record<string, unknown>, ip: string): Promise<Response> {
  resetIpBuckets(); // isolate the in-memory bucket — the DB lock is under test
  return joinRoute(
    makeRequest(`/api/events/${idOrSlug}/join`, { body, cookie, headers: { 'x-forwarded-for': ip } }),
    { params: Promise.resolve({ eventIdOrSlug: idOrSlug }) },
  );
}

function ipHash(ip: string): string {
  return hmacHex(ip, requireHashPepper());
}

async function attemptRows(eventId: string, ip: string): Promise<number> {
  const sql = getSql();
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM join_attempts WHERE event_id = ${eventId} AND ip_hash = ${ipHash(ip)}
  `;
  return rows[0]?.count ?? 0;
}

test('F-02: 20 wrong codes → recorded; 21st attempt (even correct code) → 429 join_code_locked', async () => {
  const orgCookie = await login('lock-org');
  const memberCookie = await login('lock-member');
  const e = await createClosedEvent(orgCookie, 'LOCKDOWN99');

  // 20 wrong codes: each recorded as a fact row, each answered 403 join_forbidden.
  for (let i = 0; i < 20; i++) {
    const res = await joinFromIp(memberCookie, e.id, { join_code: `GUESS${String(i).padStart(2, '0')}` }, LOCKED_IP);
    assert.equal(res.status, 403, `attempt ${i + 1} should be 403 before the lock`);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'join_forbidden');
  }
  assert.equal(await attemptRows(e.id, LOCKED_IP), 20, '20 failed attempts must be recorded');

  // 21st attempt with the CORRECT code: the lock is checked before the code.
  const locked = await joinFromIp(memberCookie, e.id, { join_code: 'LOCKDOWN99' }, LOCKED_IP);
  assert.equal(locked.status, 429);
  const lockedBody = (await locked.json()) as { code: string; retryable: boolean };
  assert.equal(lockedBody.code, 'join_code_locked');
  assert.equal(lockedBody.retryable, true);
  assert.equal(await attemptRows(e.id, LOCKED_IP), 20, 'a locked attempt must not add rows');

  // Another IP is unaffected.
  assert.equal(await attemptRows(e.id, CLEAN_IP), 0);
});

test('F-02: window expiry restores access and a successful join clears the (event, ip) history', async () => {
  const orgCookie = await login('clean-org');
  const memberCookie = await login('clean-member');
  const e = await createClosedEvent(orgCookie, 'CLEANUP777');

  for (let i = 0; i < 20; i++) {
    assert.equal(
      (await joinFromIp(memberCookie, e.id, { join_code: 'NOPE0000' }, LOCKED_IP)).status,
      403,
    );
  }
  const locked = await joinFromIp(memberCookie, e.id, { join_code: 'LOCKDOWN99' }, LOCKED_IP);
  assert.equal(locked.status, 429);

  // Simulate the 15-minute window passing.
  const sql = getSql();
  await sql`UPDATE join_attempts SET attempted_at = now() - interval '16 minutes' WHERE event_id = ${e.id}`;

  const ok = await joinFromIp(memberCookie, e.id, { join_code: 'CLEANUP777' }, LOCKED_IP);
  assertStatus(ok, 200);
  const okBody = (await ok.json()) as { ok: boolean; already_member: boolean };
  assert.equal(okBody.ok, true);
  assert.equal(okBody.already_member, false);

  // Successful join cleans up ALL attempt rows for this (event, ip).
  assert.equal(await attemptRows(e.id, LOCKED_IP), 0);
});

test('F-02: join_code shorter than 8 chars is rejected at settings (JOIN_CODE_MIN 4→8)', async () => {
  const orgCookie = await login('minlen-org');
  const e = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'MinLen Meetup', mode: 'offline', access_mode: 'closed', timezone: 'Europe/Madrid' },
      cookie: orgCookie,
    }),
  );
  assertStatus(e, 201);
  const event = ((await e.json()) as { event: { id: string } }).event;
  const res = await settingsRoute(
    makeRequest(`/api/organizer/events/${event.id}/settings`, { body: { join_code: 'HACK' }, cookie: orgCookie }),
    { params: Promise.resolve({ eventId: event.id }) },
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'invalid_join_code');
});

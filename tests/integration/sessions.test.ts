import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { GET as listSessions, DELETE as revokeAllSessions } from '../../src/app/api/me/sessions/route';
import { DELETE as revokeSession } from '../../src/app/api/me/sessions/[id]/route';
import { getSql, closeSql } from '../../src/lib/db';
import { hashSessionToken } from '../../src/lib/crypto';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

/**
 * Active sessions: the device list on /me/security.
 *
 * The list must never carry token material, revoking your own session is
 * allowed (it just ends), and somebody else's session id answers 404 — never
 * 403, which would confirm the id exists.
 */

after(async () => {
  await closeSql();
});

interface SessionListBody {
  sessions: { id: string; created_at: string; last_seen_at: string; current: boolean }[];
}

async function list(cookie: string): Promise<Response> {
  return listSessions(makeRequest('/api/me/sessions', { method: 'GET', cookie }));
}

async function revoke(cookie: string, id: string): Promise<Response> {
  return revokeSession(makeRequest(`/api/me/sessions/${id}`, { method: 'DELETE', cookie }), {
    params: Promise.resolve({ id }),
  });
}

function tokenOf(cookie: string): string {
  return cookie.split('=').slice(1).join('=');
}

/** True when the sessions row behind this cookie still exists. */
async function sessionRowExists(cookie: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    SELECT 1 FROM sessions WHERE token_hash = ${hashSessionToken(tokenOf(cookie))} LIMIT 1
  `;
  return rows.length > 0;
}

test('sessions: the list marks the current session and carries no token material', async () => {
  const email = uniqueEmail('sess-list');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);

  const res = await list(cookie);
  assertStatus(res, 200);
  const raw = await res.clone().text();
  const body = JSON.parse(raw) as SessionListBody;

  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0]!.current, true);
  // The projection is exactly these four fields — nothing token-shaped.
  assert.deepEqual(Object.keys(body.sessions[0]!).sort(), ['created_at', 'current', 'id', 'last_seen_at']);
  // The session token itself must not appear anywhere in the payload.
  assert.ok(!raw.includes(tokenOf(cookie)), 'the response must not contain the session token');
  assert.ok(!/token/i.test(raw), 'the response must not mention tokens at all');
  // Timestamps are ISO-8601 and parseable.
  assert.ok(!Number.isNaN(Date.parse(body.sessions[0]!.created_at)));
  assert.ok(!Number.isNaN(Date.parse(body.sessions[0]!.last_seen_at)));
});

test('sessions: the current session comes first, then most recently seen', async () => {
  const email = uniqueEmail('sess-order');
  const first = await loginViaOtp(requestOtp, verifyOtp, email);
  const second = await loginViaOtp(requestOtp, verifyOtp, email);

  // Give the older session the OLDER last_seen_at so ordering is unambiguous.
  const sql = getSql();
  await sql`
    UPDATE sessions SET last_seen_at = now() - interval '2 hours'
    WHERE token_hash = ${hashSessionToken(tokenOf(first))}
  `;

  const res = await list(second);
  assertStatus(res, 200);
  const body = (await res.json()) as SessionListBody;
  assert.equal(body.sessions.length, 2);
  assert.equal(body.sessions[0]!.current, true, 'the calling session must be first');
  assert.equal(body.sessions[1]!.current, false);

  // The same account, seen from the OTHER session: the order flips.
  const other = await list(first);
  assertStatus(other, 200);
  const otherBody = (await other.json()) as SessionListBody;
  assert.equal(otherBody.sessions[0]!.current, true);
  assert.notEqual(otherBody.sessions[0]!.id, body.sessions[0]!.id);
});

test('sessions: an expired session is not listed', async () => {
  const email = uniqueEmail('sess-expired');
  const live = await loginViaOtp(requestOtp, verifyOtp, email);
  const stale = await loginViaOtp(requestOtp, verifyOtp, email);

  const sql = getSql();
  await sql`
    UPDATE sessions SET expires_at = now() - interval '1 second'
    WHERE token_hash = ${hashSessionToken(tokenOf(stale))}
  `;

  const res = await list(live);
  assertStatus(res, 200);
  const body = (await res.json()) as SessionListBody;
  assert.equal(body.sessions.length, 1);
});

test('sessions: revoking another session deletes the row and kills its cookie', async () => {
  const email = uniqueEmail('sess-revoke');
  const keep = await loginViaOtp(requestOtp, verifyOtp, email);
  const victim = await loginViaOtp(requestOtp, verifyOtp, email);

  const listRes = await list(keep);
  assertStatus(listRes, 200);
  const { sessions } = (await listRes.json()) as SessionListBody;
  const target = sessions.find((s) => !s.current)!;
  assert.ok(target, 'the other session must be listed');

  const res = await revoke(keep, `${target.id}`);
  assertStatus(res, 200);
  const body = (await res.json()) as { revoked: number; current_revoked: boolean };
  assert.equal(body.revoked, 1);
  assert.equal(body.current_revoked, false);

  // Gone from the database…
  assert.equal(await sessionRowExists(victim), false);
  // …and the revoked cookie can no longer authenticate.
  assertStatus(await list(victim), 401);
  // The caller's own session is untouched.
  assertStatus(await list(keep), 200);
});

test('sessions: revoking the current session is allowed and ends it', async () => {
  const email = uniqueEmail('sess-self');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);

  const listRes = await list(cookie);
  const { sessions } = (await listRes.json()) as SessionListBody;
  const own = sessions[0]!;
  assert.equal(own.current, true);

  const res = await revoke(cookie, own.id);
  assertStatus(res, 200);
  const body = (await res.json()) as { current_revoked: boolean };
  assert.equal(body.current_revoked, true);

  // The cookie is cleared on the way out…
  const setCookie = res.headers.getSetCookie().join(';');
  assert.match(setCookie, /welcome_session=;/);
  assert.match(setCookie, /Max-Age=0/i);
  // …and the session really is gone.
  assert.equal(await sessionRowExists(cookie), false);
  assertStatus(await list(cookie), 401);
});

test('sessions: another account\'s session answers 404, never 403', async () => {
  const mine = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail('sess-mine'));
  const theirs = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail('sess-theirs'));

  const theirList = await list(theirs);
  const { sessions } = (await theirList.json()) as SessionListBody;
  const theirSessionId = sessions[0]!.id;

  const res = await revoke(mine, theirSessionId);
  // 404 rather than 403: the response must not confirm that the id exists.
  assertStatus(res, 404);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'not_found');

  // Their session survives the attempt.
  assert.equal(await sessionRowExists(theirs), true);
  assertStatus(await list(theirs), 200);
});

test('sessions: a malformed id is a 404, not a crash', async () => {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail('sess-bad-id'));
  const res = await revoke(cookie, 'not-a-uuid');
  assertStatus(res, 404);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'not_found');
});

test('sessions: sign out everywhere revokes every session of the account', async () => {
  const email = uniqueEmail('sess-all');
  const first = await loginViaOtp(requestOtp, verifyOtp, email);
  const second = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(first);

  const res = await revokeAllSessions(makeRequest('/api/me/sessions', { method: 'DELETE', cookie: first }));
  assertStatus(res, 200);
  const body = (await res.json()) as { revoked: number; current_revoked: boolean };
  assert.equal(body.revoked, 2);
  assert.equal(body.current_revoked, true);

  const sql = getSql();
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM sessions WHERE account_id = ${accountId}
  `;
  assert.equal(rows[0]!.count, 0);

  assertStatus(await list(first), 401);
  assertStatus(await list(second), 401);
});

test('sessions: anonymous callers cannot read or revoke', async () => {
  const anon = await listSessions(makeRequest('/api/me/sessions', { method: 'GET' }));
  assertStatus(anon, 401);

  const anonRevoke = await revokeSession(
    makeRequest('/api/me/sessions/00000000-0000-0000-0000-000000000000', { method: 'DELETE' }),
    { params: Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' }) },
  );
  assertStatus(anonRevoke, 401);

  const anonAll = await revokeAllSessions(makeRequest('/api/me/sessions', { method: 'DELETE' }));
  assertStatus(anonAll, 401);
});

test('sessions: last_seen_at is refreshed by an authenticated request', async () => {
  const email = uniqueEmail('sess-seen');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const sql = getSql();
  const tokenHash = hashSessionToken(tokenOf(cookie));

  // Backdate beyond the 5-minute throttle so the next request must bump it.
  await sql`
    UPDATE sessions SET last_seen_at = now() - interval '20 minutes' WHERE token_hash = ${tokenHash}
  `;
  const before = await sql<{ last_seen_at: Date }[]>`
    SELECT last_seen_at FROM sessions WHERE token_hash = ${tokenHash}
  `;

  assertStatus(await list(cookie), 200);

  const after_ = await sql<{ last_seen_at: Date }[]>`
    SELECT last_seen_at FROM sessions WHERE token_hash = ${tokenHash}
  `;
  assert.ok(
    new Date(after_[0]!.last_seen_at).getTime() > new Date(before[0]!.last_seen_at).getTime(),
    'an authenticated request must advance last_seen_at once the throttle window has passed',
  );
});

test('sessions: the throttled bump does not write on every request', async () => {
  const email = uniqueEmail('sess-throttle');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const sql = getSql();
  const tokenHash = hashSessionToken(tokenOf(cookie));

  await sql`
    UPDATE sessions SET last_seen_at = now() - interval '20 minutes' WHERE token_hash = ${tokenHash}
  `;
  assertStatus(await list(cookie), 200);
  const firstBump = (
    await sql<{ last_seen_at: Date }[]>`SELECT last_seen_at FROM sessions WHERE token_hash = ${tokenHash}`
  )[0]!.last_seen_at;

  // A second immediate request is inside the window: the timestamp must not move.
  assertStatus(await list(cookie), 200);
  const secondBump = (
    await sql<{ last_seen_at: Date }[]>`SELECT last_seen_at FROM sessions WHERE token_hash = ${tokenHash}`
  )[0]!.last_seen_at;

  assert.equal(
    new Date(secondBump).getTime(),
    new Date(firstBump).getTime(),
    'last_seen_at must be throttled, not written on every request',
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as otpRequest } from '../../src/app/api/auth/otp/request/route';
import { POST as otpVerify } from '../../src/app/api/auth/otp/verify/route';
import { getSql, closeSql } from '../../src/lib/db';
import { makeRequest, uniqueEmail, assertStatus, loginViaOtp } from './helpers';
import { emailLookupHash } from '../../src/lib/crypto';
import { requireHashPepper } from '../../src/lib/env';

// ---------------------------------------------------------------------------
// F-13: durable per-account failed-verify window (5 / 15 min). Even the
// CORRECT code is rejected while locked, with the enumeration-safe
// `401 invalid_code`; a successful verify clears the counter.
// ---------------------------------------------------------------------------

after(async () => {
  await closeSql();
});

async function accountFailureRows(email: string): Promise<number> {
  const hash = emailLookupHash(email, requireHashPepper());
  const sql = getSql();
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM otp_verify_failures f
    JOIN accounts a ON a.id = f.account_id
    WHERE a.email_lookup_hash = ${hash}
  `;
  return rows[0]!.count;
}

test('F-13: 5 wrong verifies lock the account — correct code rejected until window slides', async () => {
  const email = uniqueEmail('f13-lock');
  const reqRes = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
  assertStatus(reqRes, 200);
  const { devCode } = (await reqRes.json()) as { devCode: string };

  // 5 wrong codes: recorded as failures (and each burns the code's attempts).
  for (let i = 0; i < 5; i++) {
    const res = await otpVerify(makeRequest('/api/auth/otp/verify', { body: { email, code: `00000${i}`.slice(-6) === devCode ? '999999' : '000000' } }));
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'invalid_code');
  }
  assert.equal(await accountFailureRows(email), 5, 'five failures recorded');

  // The 6th attempt uses the CORRECT code — still rejected (locked).
  const locked = await otpVerify(makeRequest('/api/auth/otp/verify', { body: { email, code: devCode } }));
  assert.equal(locked.status, 401);
  assert.equal(((await locked.json()) as { code: string }).code, 'invalid_code', 'lock response stays enumeration-safe');
  assert.equal(await accountFailureRows(email), 5, 'locked attempts are not recorded');

  // Simulate the 15-minute window sliding clear. The original code was
  // consumed by the 5 wrong attempts, so a fresh code is requested.
  const hash = emailLookupHash(email, requireHashPepper());
  const sql = getSql();
  await sql`
    UPDATE otp_verify_failures SET attempted_at = now() - interval '16 minutes'
    WHERE account_id = (SELECT id FROM accounts WHERE email_lookup_hash = ${hash})
  `;
  const reqRes2 = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
  assertStatus(reqRes2, 200);
  const { devCode: freshCode } = (await reqRes2.json()) as { devCode: string };
  const ok = await otpVerify(makeRequest('/api/auth/otp/verify', { body: { email, code: freshCode } }));
  assertStatus(ok, 200);
  assert.equal(await accountFailureRows(email), 0, 'a successful verify clears the counter');
});

test('F-13: another account is unaffected by one account being locked', async () => {
  const email = uniqueEmail('f13-other');
  const cookie = await loginViaOtp(otpRequest, otpVerify, email);
  assert.match(cookie, /^welcome_session=/);
});

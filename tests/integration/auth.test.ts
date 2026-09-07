import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { POST as otpRequest } from '../../src/app/api/auth/otp/request/route';
import { POST as otpVerify } from '../../src/app/api/auth/otp/verify/route';
import { POST as logout } from '../../src/app/api/auth/logout/route';
import { GET as meProfile } from '../../src/app/api/me/profile/route';
import { makeRequest, uniqueEmail, loginViaOtp, assertStatus } from './helpers';
import { getSql, closeSql } from '../../src/lib/db';
import { emailLookupHash } from '../../src/lib/crypto';
import { requireHashPepper } from '../../src/lib/env';

after(async () => {
  await closeSql();
});

test('otp request: exposes devCode only when AUTH_DEV_EXPOSE_OTP=true; response always ok:true', async () => {
  const email = uniqueEmail('devcode');
  const res = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
  assertStatus(res, 200);
  const body = (await res.json()) as { ok: boolean; devCode?: string };
  assert.equal(body.ok, true);
  assert.match(body.devCode ?? '', /^\d{6}$/);
});

test('otp request: without the flag the code is NOT returned and lands in .runtime/otp.log', async () => {
  const email = uniqueEmail('logged');
  process.env.AUTH_DEV_EXPOSE_OTP = 'false';
  try {
    const res = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
    assertStatus(res, 200);
    const body = (await res.json()) as { ok: boolean; devCode?: string };
    assert.equal(body.ok, true);
    assert.equal(body.devCode, undefined, 'devCode must never be returned when the flag is off');

    const log = await readFile(path.join(process.cwd(), '.runtime', 'otp.log'), 'utf8');
    const line = log.split('\n').find((l) => l.includes(email));
    assert.ok(line, 'otp.log must contain the code for the dev email');
    assert.match(line as string, /\t\d{6}$/);
  } finally {
    process.env.AUTH_DEV_EXPOSE_OTP = 'true';
  }
});

test('otp verify: wrong code 5 times invalidates the OTP, then even the right code fails', async () => {
  const email = uniqueEmail('attempts');
  const reqRes = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
  const { devCode } = (await reqRes.json()) as { devCode: string };

  for (let i = 0; i < 5; i++) {
    const res = await otpVerify(makeRequest('/api/auth/otp/verify', { body: { email, code: '000000' === devCode ? '111111' : '000000' } }));
    assertStatus(res, 401);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'invalid_code');
  }

  const res = await otpVerify(makeRequest('/api/auth/otp/verify', { body: { email, code: devCode } }));
  assertStatus(res, 401);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'invalid_code', 'correct code must be rejected after 5 failed attempts');
});

test('otp verify: success sets HttpOnly SameSite=Lax welcome_session cookie and creates a working session', async () => {
  const email = uniqueEmail('success');
  const cookie = await loginViaOtp(otpRequest, otpVerify, email);
  assert.match(cookie, /^welcome_session=[A-Za-z0-9_-]+$/);

  const res = await meProfile(makeRequest('/api/me/profile', { cookie }));
  assertStatus(res, 200);
  const body = (await res.json()) as { ok: boolean; profile: unknown };
  assert.equal(body.ok, true);
  assert.equal(body.profile, null);
});

test('otp verify: cookie flags are HttpOnly, SameSite=Lax; secure only in production', async () => {
  const email = uniqueEmail('flags');
  const reqRes = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
  const { devCode } = (await reqRes.json()) as { devCode: string };
  const res = await otpVerify(makeRequest('/api/auth/otp/verify', { body: { email, code: devCode } }));
  const setCookie = res.headers.getSetCookie()[0] ?? '';
  assert.match(setCookie, /welcome_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /Secure/i); // APP_ENV=development in the integration env
});

test('otp verify: unknown email and wrong code produce identical responses (enumeration-safe)', async () => {
  const unknown = await otpVerify(
    makeRequest('/api/auth/otp/verify', { body: { email: uniqueEmail('unknown'), code: '123456' } }),
  );
  const wrong = await otpVerify(
    makeRequest('/api/auth/otp/verify', { body: { email: uniqueEmail('known'), code: '000000' } }),
  );
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  const ub = (await unknown.json()) as { code: string };
  const wb = (await wrong.json()) as { code: string };
  assert.equal(ub.code, 'invalid_code');
  assert.equal(wb.code, 'invalid_code');
});

test('otp request: rate limited after 3 codes per 15 minutes per account', async () => {
  const email = uniqueEmail('ratelimit');
  for (let i = 0; i < 3; i++) {
    const res = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
    assertStatus(res, 200);
  }
  const fourth = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
  assert.equal(fourth.status, 429);
  const body = (await fourth.json()) as { code: string; retryable: boolean };
  assert.equal(body.code, 'rate_limited');
  assert.equal(body.retryable, true);
});

test('otp request: malformed email is rejected; verify with malformed code is rejected', async () => {
  const badEmail = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email: 'not-an-email' } }));
  assert.equal(badEmail.status, 400);
  const noBody = await otpRequest(makeRequest('/api/auth/otp/request', { body: {} }));
  assert.equal(noBody.status, 400);
  const badCode = await otpVerify(makeRequest('/api/auth/otp/verify', { body: { email: uniqueEmail('x'), code: '12ab56' } }));
  assert.equal(badCode.status, 400);
});

test('session: expired session is rejected', async () => {
  const email = uniqueEmail('expire');
  const cookie = await loginViaOtp(otpRequest, otpVerify, email);
  assertStatus(await meProfile(makeRequest('/api/me/profile', { cookie })), 200);

  const sql = getSql();
  const hash = emailLookupHash(email, requireHashPepper());
  await sql`UPDATE sessions SET expires_at = now() - interval '1 second'
            WHERE account_id = (SELECT id FROM accounts WHERE email_lookup_hash = ${hash})`;

  const res = await meProfile(makeRequest('/api/me/profile', { cookie }));
  assert.equal(res.status, 401);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'unauthorized');
});

test('logout: destroys the session server-side and clears the cookie', async () => {
  const email = uniqueEmail('logout');
  const cookie = await loginViaOtp(otpRequest, otpVerify, email);
  assertStatus(await meProfile(makeRequest('/api/me/profile', { cookie })), 200);

  const res = await logout(makeRequest('/api/auth/logout', { method: 'POST', cookie }));
  assertStatus(res, 200);
  const setCookie = res.headers.getSetCookie()[0] ?? '';
  assert.match(setCookie, /welcome_session=;/); // cleared
  assert.match(setCookie, /Max-Age=0/i);

  const afterLogout = await meProfile(makeRequest('/api/me/profile', { cookie }));
  assert.equal(afterLogout.status, 401);
});

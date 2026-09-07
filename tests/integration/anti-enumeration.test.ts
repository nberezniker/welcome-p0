import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtpRoute } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtpRoute } from '../../src/app/api/auth/otp/verify/route';
import { GET as publicProfile } from '../../src/app/api/public/profiles/[slug]/route';
import { getSql, closeSql } from '../../src/lib/db';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

/** Phase 5 anti-enumeration regression: response shapes and messages are
 * identical whether the subject exists or not. */

after(async () => {
  await closeSql();
});

const sql = getSql();

test('OTP request: unknown and known emails produce an identical response shape', async () => {
  const unknown = makeRequest('/api/auth/otp/request', { body: { email: uniqueEmail('enum-unknown') } });
  const knownEmail = uniqueEmail('enum-known');
  await assertStatus(await requestOtpRoute(makeRequest('/api/auth/otp/request', { body: { email: knownEmail } })), 200);
  const known = makeRequest('/api/auth/otp/request', { body: { email: knownEmail } });

  const [unknownRes, knownRes] = [await requestOtpRoute(unknown), await requestOtpRoute(known)];
  assert.equal(unknownRes.status, knownRes.status);
  const unknownBody = (await unknownRes.json()) as Record<string, unknown>;
  const knownBody = (await knownRes.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(unknownBody).sort(), Object.keys(knownBody).sort());
  assert.equal(unknownBody.ok, knownBody.ok);
  // both branches expose the dev code in the dev environment — never a "no such user" hint
  assert.equal(typeof unknownBody.devCode, typeof knownBody.devCode);
  assert.equal(typeof unknownBody.devCode, 'string');
});

test('OTP verify: wrong code for unknown and known emails yields identical 401 bodies', async () => {
  const knownEmail = uniqueEmail('enum-verify-known');
  const cookie = await loginViaOtp(requestOtpRoute, verifyOtpRoute, knownEmail);
  assert.ok(cookie);

  const unknown = await verifyOtpRoute(
    makeRequest('/api/auth/otp/verify', { body: { email: uniqueEmail('enum-verify-unknown'), code: '000000' } }),
  );
  const known = await verifyOtpRoute(
    makeRequest('/api/auth/otp/verify', { body: { email: knownEmail, code: '000000' } }),
  );

  assert.equal(unknown.status, 401);
  assert.equal(known.status, 401);
  const u = (await unknown.json()) as { code: string; message: string; correlation_id: string; retryable: boolean };
  const k = (await known.json()) as { code: string; message: string; correlation_id: string; retryable: boolean };
  assert.equal(u.code, 'invalid_code');
  assert.equal(u.code, k.code);
  assert.equal(u.message, k.message);
  assert.equal(u.retryable, k.retryable);
});

test('profile public API: unknown slug and deactivated account return the same generic 404', async () => {
  // real account with a public profile…
  const email = uniqueEmail('enum-slug');
  const cookie = await loginViaOtp(requestOtpRoute, verifyOtpRoute, email);
  const createRes = await (await import('../../src/app/api/me/profile/route')).POST(
    makeRequest('/api/me/profile', { body: { display_name: 'Enum Target' }, cookie }),
  );
  assertStatus(createRes, 200);
  const slug = ((await createRes.json()) as { profile: { public_slug: string } }).profile.public_slug;
  const accountId = await accountIdFromCookie(cookie);
  await sql`UPDATE accounts SET status = 'disabled' WHERE id = ${accountId}`;

  const deactivated = await publicProfile(makeRequest(`/api/public/profiles/${slug}`), {
    params: Promise.resolve({ slug }),
  });
  const unknownSlug = await publicProfile(makeRequest('/api/public/profiles/no-such-slug-aaaaaaaaaa'), {
    params: Promise.resolve({ slug: 'no-such-slug-aaaaaaaaaa' }),
  });

  assert.equal(deactivated.status, 404);
  assert.equal(unknownSlug.status, 404);
  const d = (await deactivated.json()) as { code: string; message: string };
  const u = (await unknownSlug.json()) as { code: string; message: string };
  assert.equal(d.code, 'not_found');
  assert.equal(d.code, u.code);
  assert.equal(d.message, u.message);
});

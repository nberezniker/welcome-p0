import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as otpRequest } from '../../src/app/api/auth/otp/request/route';
import { POST as localeRoute } from '../../src/app/api/locale/route';
import { makeRequest, uniqueEmail, assertStatus } from './helpers';

/** Phase 5 hardening: CSRF origin enforcement + generic per-IP rate limits.
 * The guards live in src/lib/http.ts and wrap every mutating handler. */

interface ErrBody {
  code: string;
  message: string;
  correlation_id: string;
  retryable: boolean;
}

test('CSRF: cross-origin mutating POST with evil Origin → 403 csrf_origin', async () => {
  const res = await localeRoute(
    makeRequest('/api/locale', {
      method: 'POST',
      body: { locale: 'ru' },
      headers: { origin: 'https://evil.example' },
    }),
  );
  assert.equal(res.status, 403);
  const body = (await res.json()) as ErrBody;
  assert.equal(body.code, 'csrf_origin');
  assert.equal(body.retryable, false);
  assert.match(body.correlation_id, /^[0-9a-f-]{36}$/);
});

test('CSRF: cross-site marker without Origin → 403', async () => {
  const res = await localeRoute(
    makeRequest('/api/locale', {
      method: 'POST',
      body: { locale: 'ru' },
      headers: { 'sec-fetch-site': 'cross-site' },
    }),
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as ErrBody).code, 'csrf_origin');
});

test('CSRF: Origin "null" (sandboxed frame) → 403', async () => {
  const res = await localeRoute(
    makeRequest('/api/locale', {
      method: 'POST',
      body: { locale: 'ru' },
      headers: { origin: 'null' },
    }),
  );
  assert.equal(res.status, 403);
});

test('CSRF: same-origin Origin passes (guard is not triggered)', async () => {
  const res = await localeRoute(
    makeRequest('/api/locale', {
      method: 'POST',
      body: { locale: 'ru' },
      headers: { origin: 'http://localhost:3000' },
    }),
  );
  assert.notEqual(res.status, 403);
  const body = (await res.json()) as { code?: string };
  assert.notEqual(body.code, 'csrf_origin');
});

test('CSRF: X-Forwarded-Host proxy setup — matching Origin passes', async () => {
  const res = await localeRoute(
    makeRequest('/api/locale', {
      method: 'POST',
      body: { locale: 'en' },
      headers: { origin: 'https://welcome.example.org', 'x-forwarded-host': 'welcome.example.org' },
    }),
  );
  assert.notEqual(res.status, 403);
});

test('CSRF: no Origin at all (curl / server-to-server style) passes', async () => {
  const res = await localeRoute(makeRequest('/api/locale', { method: 'POST', body: { locale: 'ru' } }));
  assert.notEqual(res.status, 403);
});

test('CSRF: GET requests are never origin-guarded', async () => {
  // GET handlers are not wrapped for origin checks — an evil Origin on a GET
  // must flow through to the handler (404 here), never the 403 csrf_origin.
  const { GET: publicProfile } = await import('../../src/app/api/public/profiles/[slug]/route');
  const res = await publicProfile(
    makeRequest('/api/public/profiles/no-such-slug-000000', {
      headers: { origin: 'https://evil.example' },
    }),
    { params: Promise.resolve({ slug: 'no-such-slug-000000' }) },
  );
  assert.equal(res.status, 404);
  assert.notEqual(((await res.json()) as ErrBody).code, 'csrf_origin');
});

test('rate limit: 11 OTP requests from one IP within the window → last is 429', async () => {
  const ip = '203.0.113.7';
  const send = () =>
    otpRequest(
      makeRequest('/api/auth/otp/request', {
        body: { email: uniqueEmail('rl') },
        headers: { 'x-forwarded-for': ip },
      }),
    );

  for (let i = 0; i < 10; i++) {
    const res = await send();
    assertStatus(res, 200);
    assert.equal(res.headers.get('x-ratelimit-limit'), '10');
  }

  const eleventh = await send();
  assert.equal(eleventh.status, 429);
  const body = (await eleventh.json()) as ErrBody;
  assert.equal(body.code, 'rate_limited');
  assert.equal(body.retryable, true);
  assert.equal(eleventh.headers.get('x-ratelimit-remaining'), '0');
  const retryAfter = Number(eleventh.headers.get('retry-after'));
  assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1, 'Retry-After must be present on 429');
  assert.equal(eleventh.headers.get('x-ratelimit-limit'), '10');
});

test('rate limit: another IP is not affected by the exhausted bucket', async () => {
  const res = await otpRequest(
    makeRequest('/api/auth/otp/request', {
      body: { email: uniqueEmail('rl-other') },
      headers: { 'x-forwarded-for': '203.0.113.8' },
    }),
  );
  assertStatus(res, 200);
  assert.ok(Number(res.headers.get('x-ratelimit-remaining')) >= 0);
});

test('rate limit: success responses carry X-RateLimit headers on governed routes', async () => {
  const res = await otpRequest(
    makeRequest('/api/auth/otp/request', {
      body: { email: uniqueEmail('rl-headers') },
      headers: { 'x-forwarded-for': '203.0.113.9' },
    }),
  );
  assertStatus(res, 200);
  assert.equal(res.headers.get('x-ratelimit-limit'), '10');
  assert.ok(res.headers.get('x-ratelimit-remaining'));
  assert.ok(res.headers.get('x-ratelimit-reset'));
});

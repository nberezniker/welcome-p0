import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as postConsent } from '../../src/app/api/consents/route';
import { POST as revokeConsent } from '../../src/app/api/consents/revoke/route';
import { getSql, closeSql } from '../../src/lib/db';
import { hasGrant } from '../../src/domain/consent';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

after(async () => {
  await closeSql();
});

async function login(): Promise<{ cookie: string; accountId: string }> {
  const email = uniqueEmail('consent');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  return { cookie, accountId: await accountIdFromCookie(cookie) };
}

test('consent: grant then withdraw flips hasGrant; latest record wins', async () => {
  const { cookie, accountId } = await login();

  const grant = await postConsent(
    makeRequest('/api/consents', {
      body: { action: 'grant', purpose: 'event_directory', scope_type: 'global', policy_version: '2026-09-07' },
      cookie,
    }),
  );
  assertStatus(grant, 200);

  const sql = getSql();
  assert.equal(await hasGrant(sql, accountId, 'event_directory'), true);

  const revoke = await revokeConsent(
    makeRequest('/api/consents/revoke', {
      body: { purpose: 'event_directory', scope_type: 'global', policy_version: '2026-09-07' },
      cookie,
    }),
  );
  assertStatus(revoke, 200);
  assert.equal(await hasGrant(sql, accountId, 'event_directory'), false);
});

test('consent: revoke writes consent.suppress_requested audit (phase-3 outbox stub)', async () => {
  const { cookie, accountId } = await login();

  await postConsent(
    makeRequest('/api/consents', {
      body: { action: 'grant', purpose: 'product_marketing', scope_type: 'global', policy_version: '2026-09-07' },
      cookie,
    }),
  );
  await revokeConsent(
    makeRequest('/api/consents/revoke', {
      body: { purpose: 'product_marketing', scope_type: 'global', policy_version: '2026-09-07' },
      cookie,
    }),
  );

  const sql = getSql();
  const audits = await sql<{ id: number }[]>`
    SELECT id FROM audit_events
    WHERE actor_account_id = ${accountId} AND action = 'consent.suppress_requested'
  `;
  assert.equal(audits.length >= 1, true, 'suppress_requested audit expected');
});

test('consent: event-scoped grant does NOT imply global scope (interpretation ⑧)', async () => {
  const { cookie, accountId } = await login();

  const eventScopeId = '3f2c6e40-7e1b-4f5c-9a3d-0a1b2c3d4e5f';
  const grant = await postConsent(
    makeRequest('/api/consents', {
      body: { action: 'grant', purpose: 'introduction_fields', scope_type: 'event', scope_id: eventScopeId, field_set: ['email'], policy_version: '2026-09-07' },
      cookie,
    }),
  );
  assertStatus(grant, 200);

  const sql = getSql();
  assert.equal(await hasGrant(sql, accountId, 'introduction_fields', { scopeType: 'event', scopeId: eventScopeId }), true);
  assert.equal(await hasGrant(sql, accountId, 'introduction_fields', { scopeType: 'global' }), false);
});

test('consent: actor is the session account — account_id in body is ignored', async () => {
  const { cookie, accountId } = await login();
  const spoofed = '11111111-1111-1111-1111-111111111111';

  const res = await postConsent(
    makeRequest('/api/consents', {
      body: {
        action: 'grant', purpose: 'service_channel', scope_type: 'global',
        policy_version: '2026-09-07', account_id: spoofed,
      },
      cookie,
    }),
  );
  assertStatus(res, 200);

  const sql = getSql();
  const rows = await sql<{ account_id: string }[]>`
    SELECT account_id FROM consent_events WHERE purpose = 'service_channel' ORDER BY id DESC LIMIT 1
  `;
  assert.equal(rows[0]?.account_id, accountId);
  assert.notEqual(rows[0]?.account_id, spoofed);
});

test('consent: 401 without session; 400 for invalid purpose and global scope_id', async () => {
  const { cookie } = await login();

  const anon = await postConsent(
    makeRequest('/api/consents', {
      body: { action: 'grant', purpose: 'event_directory', scope_type: 'global', policy_version: 'v1' },
    }),
  );
  assertStatus(anon, 401);

  const badPurpose = await postConsent(
    makeRequest('/api/consents', {
      body: { action: 'grant', purpose: 'newsletter', scope_type: 'global', policy_version: 'v1' },
      cookie,
    }),
  );
  assertStatus(badPurpose, 400);

  const globalWithScope = await postConsent(
    makeRequest('/api/consents', {
      body: { action: 'grant', purpose: 'event_directory', scope_type: 'global', scope_id: '3f2c6e40-7e1b-4f5c-9a3d-0a1b2c3d4e5f', policy_version: 'v1' },
      cookie,
    }),
  );
  assertStatus(globalWithScope, 400);
});

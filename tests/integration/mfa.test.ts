import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as createCampaignRoute } from '../../src/app/api/organizer/campaigns/route';
import { POST as approveRoute } from '../../src/app/api/organizer/campaigns/[id]/approve/route';
import { POST as sendRoute } from '../../src/app/api/organizer/campaigns/[id]/send/route';
import { POST as enrollRoute } from '../../src/app/api/me/mfa/totp/route';
import { POST as confirmRoute } from '../../src/app/api/me/mfa/totp/confirm/route';
import { DELETE as disableMfaRoute } from '../../src/app/api/me/mfa/route';
import { POST as mfaVerifyRoute } from '../../src/app/api/auth/mfa/verify/route';
import { getSql, closeSql } from '../../src/lib/db';
import { totpAt } from '../../src/lib/totp';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

after(async () => {
  await closeSql();
});

const sql = getSql();

interface Actor {
  email: string;
  cookie: string;
  accountId: string;
  profileId: string;
}

async function login(prefix: string): Promise<Actor> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `MFA ${prefix}`, languages: ['en'], offer_tags: [], need_tags: [] },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { email, cookie, accountId, profileId: rows[0]!.id };
}

/** Enrolls AND confirms TOTP for the actor; returns the secret and recovery codes. */
async function enrollAndConfirm(actor: Actor): Promise<{ secret: string; recoveryCodes: string[] }> {
  const enrollRes = await enrollRoute(
    makeRequest('/api/me/mfa/totp', { body: { email: actor.email }, cookie: actor.cookie }),
  );
  assertStatus(enrollRes, 200);
  const body = (await enrollRes.json()) as {
    secret_base32: string;
    otpauth_uri: string;
    recovery_codes: string[];
  };
  assert.match(body.otpauth_uri, /^otpauth:\/\/totp\/WELCOME:/);
  assert.equal(body.recovery_codes.length, 8);

  const confirmRes = await confirmRoute(
    makeRequest('/api/me/mfa/totp/confirm', { body: { code: totpAt(body.secret_base32) }, cookie: actor.cookie }),
  );
  assertStatus(confirmRes, 200);
  return { secret: body.secret_base32, recoveryCodes: body.recovery_codes };
}

async function createEvent(owner: Actor): Promise<string> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'MFA Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string } }).event.id;
}

async function createDraftCampaign(owner: Actor, eventId: string): Promise<string> {
  const res = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'organizer_marketing', body_text: 'mfa test message' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { campaign: { id: string } }).campaign.id;
}

function wrongCode(correct: string): string {
  return correct === '000000' ? '000001' : '000000';
}

async function approve(campaignId: string, cookie: string): Promise<Response> {
  return approveRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
}

async function sessionMfaVerifiedAt(cookie: string): Promise<Date | null> {
  const { hashSessionToken } = await import('../../src/lib/crypto');
  const token = cookie.split('=')[1] ?? '';
  const rows = await sql<{ mfa_verified_at: Date | null }[]>`
    SELECT mfa_verified_at FROM sessions WHERE token_hash = ${hashSessionToken(token)} LIMIT 1
  `;
  const value = rows[0]?.mfa_verified_at;
  return value ? new Date(value) : null;
}

/** Signs in again (OTP dev-exposed) and returns the new session cookie. */
async function newSession(email: string): Promise<string> {
  const reqRes = await requestOtp(makeRequest('/api/auth/otp/request', { body: { email } }));
  assertStatus(reqRes, 200);
  const { devCode } = (await reqRes.json()) as { devCode?: string };
  assert.ok(devCode, 'devCode required');
  const verifyRes = await verifyOtp(makeRequest('/api/auth/otp/verify', { body: { email, code: devCode! } }));
  assertStatus(verifyRes, 200);
  const setCookie = verifyRes.headers.getSetCookie()[0] ?? '';
  const token = /welcome_session=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(token, 'welcome_session cookie expected on verify response');
  return `welcome_session=${token}`;
}

/** Signs in again and asserts the mfa_required flag from the verify response. */
async function newSessionWithFlag(email: string): Promise<{ cookie: string; mfaRequired: boolean }> {
  const reqRes = await requestOtp(makeRequest('/api/auth/otp/request', { body: { email } }));
  assertStatus(reqRes, 200);
  const { devCode } = (await reqRes.json()) as { devCode?: string };
  assert.ok(devCode, 'devCode required');
  const verifyRes = await verifyOtp(makeRequest('/api/auth/otp/verify', { body: { email, code: devCode! } }));
  assertStatus(verifyRes, 200);
  const body = (await verifyRes.json()) as { ok: boolean; mfa_required?: boolean };
  const setCookie = verifyRes.headers.getSetCookie()[0] ?? '';
  const token = /welcome_session=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(token, 'welcome_session cookie expected on verify response');
  return { cookie: `welcome_session=${token}`, mfaRequired: body.mfa_required === true };
}

// ---------------------------------------------------------------------------
// Core flow: enroll → confirm → login requires MFA → step-up verify → approve
// ---------------------------------------------------------------------------

test('mfa: enroll→confirm→login requires mfa→verify→approve passes; without verify 403', async () => {
  const owner = await login('mfa-owner');
  const eventId = await createEvent(owner);
  const campaignId = await createDraftCampaign(owner, eventId);

  // No MFA enrolled yet — the legacy flow is untouched: approve just works.
  assertStatus(await approve(campaignId, owner.cookie), 200);

  const { secret } = await enrollAndConfirm(owner);

  // Fresh login of an MFA account: mfa_required flag, session NOT verified.
  const { cookie, mfaRequired } = await newSessionWithFlag(owner.email);
  assert.equal(mfaRequired, true);
  assert.equal(await sessionMfaVerifiedAt(cookie), null);

  // Owner action without step-up → 403 mfa_required.
  const gated = await approve(campaignId, cookie);
  assert.equal(gated.status, 403);
  assert.equal(((await gated.json()) as { code: string }).code, 'mfa_required');

  // Wrong TOTP at step-up → 401 mfa_invalid; the session stays unverified.
  const badVerify = await mfaVerifyRoute(
    makeRequest('/api/auth/mfa/verify', { body: { code: wrongCode(totpAt(secret)) }, cookie }),
  );
  assert.equal(badVerify.status, 401);
  assert.equal(((await badVerify.json()) as { code: string }).code, 'mfa_invalid');
  assert.equal(await sessionMfaVerifiedAt(cookie), null);

  // Correct TOTP → session verified → approve passes.
  const goodVerify = await mfaVerifyRoute(
    makeRequest('/api/auth/mfa/verify', { body: { code: totpAt(secret) }, cookie }),
  );
  assertStatus(goodVerify, 200);
  const goodBody = (await goodVerify.json()) as { mfa_verified: boolean; via: string };
  assert.equal(goodBody.mfa_verified, true);
  assert.equal(goodBody.via, 'totp');
  assert.ok((await sessionMfaVerifiedAt(cookie)) !== null);
  assertStatus(await approve(campaignId, cookie), 200);
});

test('mfa: plain login of an account WITHOUT MFA carries no mfa_required flag', async () => {
  const actor = await login('mfa-nomfa');
  const { cookie, mfaRequired } = await newSessionWithFlag(actor.email);
  assert.equal(mfaRequired, false);
  assert.equal(await sessionMfaVerifiedAt(cookie), null);
});

test('mfa: recovery code single use at step-up (second use fails)', async () => {
  const actor = await login('mfa-recovery');
  const { recoveryCodes } = await enrollAndConfirm(actor);

  const first = await mfaVerifyRoute(
    makeRequest('/api/auth/mfa/verify', { body: { code: recoveryCodes[0] }, cookie: actor.cookie }),
  );
  assertStatus(first, 200);
  assert.equal(((await first.json()) as { via: string }).via, 'recovery');

  const second = await mfaVerifyRoute(
    makeRequest('/api/auth/mfa/verify', { body: { code: recoveryCodes[0] }, cookie: actor.cookie }),
  );
  assert.equal(second.status, 401);
  assert.equal(((await second.json()) as { code: string }).code, 'mfa_invalid');
});

test('mfa: confirm rejects wrong codes and locks after 5 failures per 15 min', async () => {
  const actor = await login('mfa-lock');
  const enrollRes = await enrollRoute(
    makeRequest('/api/me/mfa/totp', { body: { email: actor.email }, cookie: actor.cookie }),
  );
  assertStatus(enrollRes, 200);
  const { secret_base32 } = (await enrollRes.json()) as { secret_base32: string };

  for (let i = 0; i < 5; i++) {
    const res = await confirmRoute(
      makeRequest('/api/me/mfa/totp/confirm', { body: { code: wrongCode(totpAt(secret_base32)) }, cookie: actor.cookie }),
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { code: string }).code, 'mfa_invalid_code');
  }
  const failures = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM mfa_verify_failures WHERE account_id = ${actor.accountId}
  `;
  assert.equal(failures[0]!.count, 5);

  // Locked: even the CORRECT code is rejected until the window slides clear.
  const locked = await confirmRoute(
    makeRequest('/api/me/mfa/totp/confirm', { body: { code: totpAt(secret_base32) }, cookie: actor.cookie }),
  );
  assert.equal(locked.status, 400);
  const rows = await sql<{ confirmed_at: Date | null }[]>`
    SELECT confirmed_at FROM mfa_credentials WHERE account_id = ${actor.accountId}
  `;
  assert.equal(rows[0]!.confirmed_at, null);
});

test('mfa: disable requires a valid TOTP and restores the legacy flow', async () => {
  const actor = await login('mfa-disable');
  const eventId = await createEvent(actor);
  const campaignId = await createDraftCampaign(actor, eventId);
  const { secret } = await enrollAndConfirm(actor);

  // Fresh session after enrollment → step-up required.
  const cookie = await newSession(actor.email);
  const gated = await approve(campaignId, cookie);
  assert.equal(gated.status, 403);
  assert.equal(((await gated.json()) as { code: string }).code, 'mfa_required');

  // Disable with a wrong code → 400; factor stays on.
  const bad = await disableMfaRoute(
    makeRequest('/api/me/mfa', { method: 'DELETE', body: { code: wrongCode(totpAt(secret)) }, cookie }),
  );
  assert.equal(bad.status, 400);
  const stillThere = await sql`SELECT 1 FROM mfa_credentials WHERE account_id = ${actor.accountId}`;
  assert.equal(stillThere.length, 1);

  // Disable with the correct code → 200; credentials and recovery codes gone.
  const ok = await disableMfaRoute(
    makeRequest('/api/me/mfa', { method: 'DELETE', body: { code: totpAt(secret) }, cookie }),
  );
  assertStatus(ok, 200);
  const creds = await sql`SELECT 1 FROM mfa_credentials WHERE account_id = ${actor.accountId}`;
  const codes = await sql`SELECT 1 FROM mfa_recovery_codes WHERE account_id = ${actor.accountId}`;
  assert.equal(creds.length, 0);
  assert.equal(codes.length, 0);

  // A new login no longer requires MFA and approve works without step-up.
  const cookie2 = await newSession(actor.email);
  assert.equal(await sessionMfaVerifiedAt(cookie2), null);
  const approved = await approve(campaignId, cookie2);
  assertStatus(approved, 200);
});

test('mfa: step-up freshness expires after 30 minutes (re-verify required)', async () => {
  const actor = await login('mfa-fresh');
  const eventId = await createEvent(actor);
  const campaignId = await createDraftCampaign(actor, eventId);
  const { secret } = await enrollAndConfirm(actor);

  const cookie = await newSession(actor.email);
  const verifyRes = await mfaVerifyRoute(
    makeRequest('/api/auth/mfa/verify', { body: { code: totpAt(secret) }, cookie }),
  );
  assertStatus(verifyRes, 200);
  assertStatus(await approve(campaignId, cookie), 200);

  // Backdate the session stamp beyond the step-up window.
  const { hashSessionToken } = await import('../../src/lib/crypto');
  await sql`
    UPDATE sessions SET mfa_verified_at = now() - interval '31 minutes'
    WHERE token_hash = ${hashSessionToken(cookie.split('=')[1]!)}
  `;
  const stale = await approve(campaignId, cookie);
  assert.equal(stale.status, 403);
  assert.equal(((await stale.json()) as { code: string }).code, 'mfa_required');
});

test('mfa: admin is exempt from the owner step-up (spec §9 owner-only)', async () => {
  const owner = await login('mfa-admin-owner');
  const admin = await login('mfa-admin');
  const eventId = await createEvent(owner);
  const campaignId = await createDraftCampaign(owner, eventId);
  await sql`
    INSERT INTO organizer_members (organizer_id, account_id, role)
    SELECT e.organizer_id, ${admin.accountId}, 'admin' FROM events e WHERE e.id = ${eventId}
  `;
  await enrollAndConfirm(admin); // admin HAS MFA but the session is NOT verified

  // Send on a draft campaign → the MFA gate must NOT trigger; the response is
  // the usual 409 not_approved (admin is exempt from mfa_required).
  const res = await sendRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/send`, { cookie: admin.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'not_approved');
});

test('mfa: enrollment requires the account login email for the otpauth label', async () => {
  const actor = await login('mfa-email');
  const res = await enrollRoute(
    makeRequest('/api/me/mfa/totp', { body: { email: 'someone-else@example.org' }, cookie: actor.cookie }),
  );
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, 'invalid_input');
  const none = await sql`SELECT 1 FROM mfa_credentials WHERE account_id = ${actor.accountId}`;
  assert.equal(none.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as otpRequest } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { POST as createIntroRoute } from '../../src/app/api/introductions/route';
import { POST as respondIntroRoute } from '../../src/app/api/introductions/[id]/respond/route';
import { POST as exportRoute } from '../../src/app/api/me/export/route';
import { makeRequest, uniqueEmail, assertStatus, loginViaOtp, accountIdFromCookie } from './helpers';
import { getSql, closeSql } from '../../src/lib/db';

// ---------------------------------------------------------------------------
// F-05: subject rights — /api/me/export includes introductions where the
// caller is a party, WITH their own consent record ONLY. The other side's
// reveal fields / decisions (third-party data) and any decrypted contact
// values of the counterparty must not appear.
// ---------------------------------------------------------------------------

after(async () => {
  await closeSql();
});

async function login(prefix: string): Promise<{ cookie: string; profileId: string }> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(otpRequest, verifyOtp, email);
  const profileRes = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `User ${prefix}`, languages: ['en'], offer_tags: ['design'], need_tags: ['frontend'] },
      cookie,
    }),
  );
  assertStatus(profileRes, 200);
  const accountId = await accountIdFromCookie(cookie);
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId} LIMIT 1`;
  return { cookie, profileId: rows[0]!.id };
}

test('F-05: export after mutual intro contains the intro with OWN consent fields only', async () => {
  const a = await login('exp-a');
  const b = await login('exp-b');
  const org = await login('exp-org');

  const eventRes = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'Export Mixer', mode: 'offline', access_mode: 'public', timezone: 'Europe/Madrid' },
      cookie: org.cookie,
    }),
  );
  assertStatus(eventRes, 201);
  const event = ((await eventRes.json()) as { event: { id: string } }).event;

  for (const member of [a, b]) {
    const joined = await joinRoute(
      makeRequest(`/api/events/${event.id}/join`, { body: {}, cookie: member.cookie }),
      { params: Promise.resolve({ eventIdOrSlug: event.id }) },
    );
    assertStatus(joined, 200);
  }

  const introRes = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: b.profileId, event_id: event.id },
      cookie: a.cookie,
    }),
  );
  assertStatus(introRes, 200);
  const introId = ((await introRes.json()) as { introduction: { id: string } }).introduction.id;

  // A reveals ONLY whatsapp; B reveals whatsapp AND phone.
  const acceptA = await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, {
      body: { decision: 'accept', reveal_fields: ['whatsapp'] },
      cookie: a.cookie,
    }),
    { params: Promise.resolve({ id: introId }) },
  );
  assertStatus(acceptA, 200);
  const acceptB = await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, {
      body: { decision: 'accept', reveal_fields: ['whatsapp', 'phone'] },
      cookie: b.cookie,
    }),
    { params: Promise.resolve({ id: introId }) },
  );
  assertStatus(acceptB, 200);
  const state = ((await acceptB.json()) as { introduction: { state: string } }).introduction.state;
  assert.equal(state, 'mutual');

  // A's export: the intro is present, with A's OWN reveal fields only.
  const exportA = await exportRoute(makeRequest('/api/me/export', { method: 'POST', body: {}, cookie: a.cookie }));
  assertStatus(exportA, 200);
  const data = (await exportA.json()) as {
    introductions: Array<{ id: string; state: string; context_key: string; event_id: string; my_decision: string; my_reveal_fields: string[] }>;
  };
  assert.equal(data.introductions.length, 1, 'A sees exactly their own intro');
  const intro = data.introductions[0]!;
  assert.equal(intro.id, introId);
  assert.equal(intro.state, 'mutual');
  assert.equal(intro.event_id, event.id);
  assert.equal(intro.my_decision, 'accept');
  assert.deepEqual(intro.my_reveal_fields, ['whatsapp'], "B's broader reveal fields must NOT leak into A's export");

  // B's export mirrors the same isolation.
  const exportB = await exportRoute(makeRequest('/api/me/export', { method: 'POST', body: {}, cookie: b.cookie }));
  assertStatus(exportB, 200);
  const dataB = (await exportB.json()) as { introductions: Array<{ my_reveal_fields: string[] }> };
  assert.equal(dataB.introductions.length, 1);
  assert.deepEqual(dataB.introductions[0]!.my_reveal_fields, ['whatsapp', 'phone']);

  // No counterparty contact values anywhere in the introductions section.
  const raw = JSON.stringify(data.introductions);
  assert.ok(!raw.includes('decrypted'), 'introductions export never carries decrypted values');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { PUT as putContactRoute, GET as getContactsRoute } from '../../src/app/api/me/contacts/route';
import { POST as exportRoute } from '../../src/app/api/me/export/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { GET as directoryRoute } from '../../src/app/api/events/[eventIdOrSlug]/directory/route';
import { GET as recommendationsRoute } from '../../src/app/api/events/[eventIdOrSlug]/recommendations/route';
import { PATCH as membershipPatchRoute } from '../../src/app/api/me/memberships/[membershipId]/route';
import { POST as attendanceRoute } from '../../src/app/api/me/memberships/[membershipId]/attendance/route';
import { PUT as noteRoute } from '../../src/app/api/me/notes/[otherProfileId]/route';
import { DELETE as blocksDeleteRoute } from '../../src/app/api/blocks/[targetAccountId]/route';
import { POST as createIntroRoute } from '../../src/app/api/introductions/route';
import { POST as respondIntroRoute } from '../../src/app/api/introductions/[id]/respond/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as settingsRoute } from '../../src/app/api/organizer/events/[eventId]/settings/route';
import { POST as inviteRoute } from '../../src/app/api/organizer/events/[eventId]/registrations/[registrationId]/invite/route';
import { POST as createCampaignRoute } from '../../src/app/api/organizer/campaigns/route';
import { PATCH as editCampaignRoute } from '../../src/app/api/organizer/campaigns/[id]/route';
import { GET as audienceRoute } from '../../src/app/api/organizer/campaigns/[id]/audience/route';
import { POST as approveRoute } from '../../src/app/api/organizer/campaigns/[id]/approve/route';
import { POST as sendRoute } from '../../src/app/api/organizer/campaigns/[id]/send/route';
import { GET as statsRoute } from '../../src/app/api/organizer/campaigns/[id]/stats/route';
import { POST as claimRoute } from '../../src/app/api/registration-claims/route';
import { POST as challengeRoute } from '../../src/app/api/channels/telegram/challenge/route';
import { POST as confirmRoute } from '../../src/app/api/channels/telegram/confirm/route';
import { getSql, closeSql } from '../../src/lib/db';
import { emailLookupHash } from '../../src/lib/crypto';
import { requireHashPepper } from '../../src/lib/env';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

/** Phase 5 consolidated IDOR / cross-tenant negative suite (direct API calls,
 * no UI). Every scenario asserts the EXACT status the API must answer with.
 * Deliberate deviations from plain 403 (existence hiding with 404) are marked
 * with ANTI-ENUMERATION in the assertion comment. */

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
      body: { display_name: `Authz ${prefix}`, languages: ['en'], offer_tags: [], need_tags: [] },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { email, cookie, accountId, profileId: rows[0]!.id };
}

async function createEvent(owner: Actor, name: string): Promise<string> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name, mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string } }).event.id;
}

async function join(actor: Actor, eventId: string): Promise<string> {
  const res = await joinRoute(
    makeRequest(`/api/events/${eventId}/join`, { body: {}, cookie: actor.cookie }),
    { params: Promise.resolve({ eventIdOrSlug: eventId }) },
  );
  assertStatus(res, 200);
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM event_memberships WHERE event_id = ${eventId} AND profile_id = ${actor.profileId}
  `;
  return rows[0]!.id;
}

// Shared fixtures: owner with event+members, a second organizer (cross-tenant),
// and a standalone outsider. Created once in the async before() hook.
let owner: Actor;
let memberA: Actor;
let memberB: Actor;
let outsider: Actor;
let rivalOwner: Actor;
let eventId: string;
let rivalEventId: string;
let membershipA: string;
let membershipB: string;

before(async () => {
  owner = await login('owner');
  memberA = await login('member-a');
  memberB = await login('member-b');
  outsider = await login('outsider');
  rivalOwner = await login('rival-owner');

  eventId = await createEvent(owner, 'Authz Meetup');
  rivalEventId = await createEvent(rivalOwner, 'Rival Meetup');
  membershipA = await join(memberA, eventId);
  membershipB = await join(memberB, eventId);

  const organizerRows = await sql<{ organizer_id: string }[]>`SELECT organizer_id FROM events WHERE id = ${eventId}`;
  const organizerId = organizerRows[0]!.organizer_id;
  await sql`
    INSERT INTO organizer_members (organizer_id, account_id, role)
    VALUES (${organizerId}, ${outsider.accountId}, 'staff')
  `;
});

test('authz: profile write targets are session-scoped — profile_id in body of another cannot be hijacked', async () => {
  const before = await sql`SELECT display_name, revision::int AS revision FROM profiles WHERE id = ${memberA.profileId}`;
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: {
        display_name: 'Hijacker Name',
        profile_id: memberA.profileId, // smuggled target — must be ignored
        revision: 1,
      },
      cookie: outsider.cookie,
    }),
  );
  assertStatus(res, 200); // applies to the CALLER's own profile only
  const after = await sql`SELECT display_name, revision::int AS revision FROM profiles WHERE id = ${memberA.profileId}`;
  assert.equal(after[0]!.display_name, before[0]!.display_name);
  assert.equal(after[0]!.revision, before[0]!.revision);
  const attacker = await sql`SELECT display_name FROM profiles WHERE account_id = ${outsider.accountId}`;
  assert.equal(attacker[0]!.display_name, 'Hijacker Name');
});

test('authz: contacts PUT is session-scoped — cannot write another account contacts (no status change, victim untouched)', async () => {
  const before = await sql`
    SELECT cf.kind FROM contact_fields cf JOIN profiles p ON p.id = cf.profile_id
    WHERE p.id = ${memberA.profileId}
  `;
  const res = await putContactRoute(
    makeRequest('/api/me/contacts', {
      method: 'PUT',
      body: { kind: 'telegram_username', value: '@hijack', public_enabled: true, account_id: memberA.accountId },
      cookie: outsider.cookie,
    }),
  );
  assertStatus(res, 200);
  const after = await sql`
    SELECT cf.kind FROM contact_fields cf JOIN profiles p ON p.id = cf.profile_id
    WHERE p.id = ${memberA.profileId}
  `;
  assert.deepEqual(after, before);
  const own = await getContactsRoute(makeRequest('/api/me/contacts', { cookie: outsider.cookie }));
  assertStatus(own, 200);
  assert.equal(((await own.json()) as { contacts: { value: string }[] }).contacts[0]?.value, '@hijack');
});

test('authz: note about a non-connected profile → 403 not_connected', async () => {
  const res = await noteRoute(
    makeRequest(`/api/me/notes/${memberA.profileId}`, {
      method: 'PUT',
      body: { note_text: 'secret note' },
      cookie: rivalOwner.cookie, // never shared an event with memberA
    }),
    { params: Promise.resolve({ otherProfileId: memberA.profileId }) },
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'not_connected');
});

test('authz: intro respond by a third party → 404 (ANTI-ENUMERATION: existence of the intro is hidden)', async () => {
  const introRes = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: memberB.profileId, event_id: eventId },
      cookie: memberA.cookie,
    }),
  );
  assertStatus(introRes, 200);
  const introId = ((await introRes.json()) as { introduction: { id: string } }).introduction.id;

  const res = await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, {
      body: { decision: 'accept' },
      cookie: rivalOwner.cookie, // not a party
    }),
    { params: Promise.resolve({ id: introId }) },
  );
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { code: string }).code, 'not_found');

  // control: a real party still responds fine afterwards
  const partyRes = await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, {
      body: { decision: 'accept' },
      cookie: memberB.cookie,
    }),
    { params: Promise.resolve({ id: introId }) },
  );
  assertStatus(partyRes, 200);
});

test('authz: membership PATCH of another → 403 forbidden', async () => {
  const res = await membershipPatchRoute(
    makeRequest(`/api/me/memberships/${membershipB}`, {
      method: 'PATCH',
      body: { directory_visible: true },
      cookie: memberA.cookie, // foreign membership
    }),
    { params: Promise.resolve({ membershipId: membershipB }) },
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
});

test('authz: attendance toggle on a foreign membership → 403 forbidden', async () => {
  const res = await attendanceRoute(
    makeRequest(`/api/me/memberships/${membershipB}/attendance`, {
      body: { present: true },
      cookie: memberA.cookie,
    }),
    { params: Promise.resolve({ membershipId: membershipB }) },
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
});

test('authz: directory of an event not joined → 403 forbidden', async () => {
  const res = await directoryRoute(
    makeRequest(`/api/events/${eventId}/directory`, { cookie: rivalOwner.cookie }),
    { params: Promise.resolve({ eventIdOrSlug: eventId }) },
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
});

test('authz: recommendations of an event not joined → 403 forbidden', async () => {
  const res = await recommendationsRoute(
    makeRequest(`/api/events/${eventId}/recommendations`, { cookie: rivalOwner.cookie }),
    { params: Promise.resolve({ eventIdOrSlug: eventId }) },
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
});

test('authz: organizer settings of a foreign event → 403 forbidden', async () => {
  const res = await settingsRoute(
    makeRequest(`/api/organizer/events/${eventId}/settings`, {
      body: { access_mode: 'closed' },
      cookie: rivalOwner.cookie,
    }),
    { params: Promise.resolve({ eventId }) },
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
});

test('authz: registration invite of a foreign event → 403 forbidden', async () => {
  const reg = await sql<{ id: string }[]>`
    INSERT INTO registrations (event_id, imported_name, email_lookup_hash, claim_state, approval_status)
    VALUES (${eventId}, 'Foreign Target', ${emailLookupHash('reg-target@integration.test', requireHashPepper())}, 'unclaimed', 'approved')
    RETURNING id
  `;
  const res = await inviteRoute(
    makeRequest(`/api/organizer/events/${eventId}/registrations/${reg[0]!.id}/invite`, {
      body: {},
      cookie: rivalOwner.cookie,
    }),
    { params: Promise.resolve({ eventId, registrationId: reg[0]!.id }) },
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
});

test('authz: campaign create on a foreign event → 403 forbidden', async () => {
  const res = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'organizer_marketing', body_text: 'hello' },
      cookie: rivalOwner.cookie,
    }),
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
});

test('authz: campaign edit/approve/send/audience/stats cross-tenant → 404 (ANTI-ENUMERATION: campaign existence hidden); staff → 403', async () => {
  const created = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'organizer_marketing', body_text: 'hello' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(created, 201);
  const campaignId = ((await created.json()) as { campaign: { id: string } }).campaign.id;

  // Cross-tenant organizer has NO organizer_members row → campaign existence hidden.
  const edit = await editCampaignRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}`, {
      method: 'PATCH',
      body: { body_text: 'hijacked' },
      cookie: rivalOwner.cookie,
    }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assert.equal(edit.status, 404);
  const approve = await approveRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: rivalOwner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assert.equal(approve.status, 404);
  const send = await sendRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/send`, { body: {}, cookie: rivalOwner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assert.equal(send.status, 404);
  const audience = await audienceRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/audience`, { cookie: rivalOwner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assert.equal(audience.status, 404);
  const stats = await statsRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/stats`, { cookie: rivalOwner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assert.equal(stats.status, 404);

  // Staff of the SAME organizer: authenticated, but explicitly 403 on every mutation.
  const staffEdit = await editCampaignRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}`, {
      method: 'PATCH',
      body: { body_text: 'staff edit' },
      cookie: outsider.cookie,
    }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assert.equal(staffEdit.status, 403);
  assert.equal(((await staffEdit.json()) as { code: string }).code, 'forbidden');
  const staffApprove = await approveRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: outsider.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assert.equal(staffApprove.status, 403);
  const staffStats = await statsRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/stats`, { cookie: outsider.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assert.equal(staffStats.status, 403);
});

test('authz: claim link proven against ANOTHER email → 403 email_mismatch', async () => {
  const reg = await sql<{ id: string }[]>`
    INSERT INTO registrations (event_id, imported_name, email_lookup_hash, claim_state, approval_status)
    VALUES (${eventId}, 'Email Proof', ${emailLookupHash('proof-target@integration.test', requireHashPepper())}, 'unclaimed', 'approved')
    RETURNING id
  `;
  const invite = await inviteRoute(
    makeRequest(`/api/organizer/events/${eventId}/registrations/${reg[0]!.id}/invite`, {
      body: {},
      cookie: owner.cookie,
    }),
    { params: Promise.resolve({ eventId, registrationId: reg[0]!.id }) },
  );
  assertStatus(invite, 200);
  const claimUrl = ((await invite.json()) as { claim_url: string }).claim_url;
  const token = claimUrl.split('/claim/')[1]!;

  const res = await claimRoute(
    makeRequest('/api/registration-claims', {
      body: { token },
      cookie: memberA.cookie, // authenticated as a different email
    }),
  );
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { code: string }).code, 'email_mismatch');
});

test('authz: telegram channel confirm with ANOTHER session → 404 (ANTI-ENUMERATION: challenge bound to its creator)', async () => {
  const challenge = await challengeRoute(
    makeRequest('/api/channels/telegram/challenge', { body: {}, cookie: memberA.cookie }),
  );
  assertStatus(challenge, 201);
  const deepLink = ((await challenge.json()) as { deep_link: string }).deep_link;
  const token = deepLink.split('link_')[1]!;

  const res = await confirmRoute(
    makeRequest('/api/channels/telegram/confirm', { body: { token }, cookie: memberB.cookie }),
  );
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { code: string }).code, 'challenge_not_found');

  // control: the owning session confirms its own challenge
  const own = await confirmRoute(
    makeRequest('/api/channels/telegram/confirm', { body: { token }, cookie: memberA.cookie }),
  );
  assertStatus(own, 200);
});

test('authz: export is session-scoped — attacker export never contains victim data', async () => {
  const res = await exportRoute(makeRequest('/api/me/export', { body: {}, cookie: outsider.cookie }));
  assertStatus(res, 200);
  const raw = JSON.stringify(await res.json());
  assert.ok(!raw.includes('Authz member-a'), 'victim display_name must not appear');
  assert.ok(!raw.includes('Authz member-b'), 'victim display_name must not appear');
});

test('authz: DELETE /api/blocks only removes the CALLER block — the victim block survives', async () => {
  await sql`
    INSERT INTO blocks (blocker_account_id, target_account_id)
    VALUES (${memberB.accountId}, ${outsider.accountId})
    ON CONFLICT DO NOTHING
  `;
  const res = await blocksDeleteRoute(
    makeRequest(`/api/blocks/${memberB.accountId}`, { method: 'DELETE', cookie: outsider.cookie }),
    { params: Promise.resolve({ targetAccountId: memberB.accountId }) },
  );
  assertStatus(res, 200);
  assert.equal(((await res.json()) as { was_blocked: boolean }).was_blocked, false);
  const kept = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM blocks
    WHERE blocker_account_id = ${memberB.accountId} AND target_account_id = ${outsider.accountId}
  `;
  assert.equal(kept[0]!.count, 1);
});

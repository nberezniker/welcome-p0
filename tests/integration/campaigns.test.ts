import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { POST as createCampaignRoute } from '../../src/app/api/organizer/campaigns/route';
import { PATCH as editCampaignRoute } from '../../src/app/api/organizer/campaigns/[id]/route';
import { GET as audienceRoute } from '../../src/app/api/organizer/campaigns/[id]/audience/route';
import { POST as approveRoute } from '../../src/app/api/organizer/campaigns/[id]/approve/route';
import { POST as sendRoute } from '../../src/app/api/organizer/campaigns/[id]/send/route';
import { GET as statsRoute } from '../../src/app/api/organizer/campaigns/[id]/stats/route';
import { POST as revokeConsentRoute } from '../../src/app/api/consents/revoke/route';
import { POST as createIntroRoute } from '../../src/app/api/introductions/route';
import { POST as respondIntroRoute } from '../../src/app/api/introductions/[id]/respond/route';
import { getSql, closeSql } from '../../src/lib/db';
import { tickOnce } from '../../src/infra/worker';
import { MockTelegramTransport } from '../../src/integrations/telegram/mock-transport';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';
import { bindTelegram, grantConsent, withdrawConsent, jobRow, attemptRows, drainWorker } from './phase3-helpers';

after(async () => {
  await closeSql();
});

const sql = getSql();

interface Actor {
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
      body: { display_name: `Campaign ${prefix}`, languages: ['en'], offer_tags: [], need_tags: [] },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { cookie, accountId, profileId: rows[0]!.id };
}

async function createEvent(owner: Actor): Promise<string> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'Campaign Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string } }).event.id;
}

async function addMember(eventId: string, member: Actor, opts: { visible?: boolean } = {}): Promise<void> {
  const res = await joinRoute(
    makeRequest(`/api/events/${eventId}/join`, { body: {}, cookie: member.cookie }),
    { params: Promise.resolve({ eventIdOrSlug: eventId }) },
  );
  assertStatus(res, 200);
  if (opts.visible) {
    await sql`UPDATE event_memberships SET directory_visible = true WHERE event_id = ${eventId} AND profile_id = ${member.profileId}`;
  }
}

async function campaignState(campaignId: string): Promise<{
  state: string;
  content_revision: number;
  approved_revision: number | null;
}> {
  const rows = await sql<{ state: string; content_revision: number; approved_revision: number | null }[]>`
    SELECT state, content_revision, approved_revision FROM campaigns WHERE id = ${campaignId}
  `;
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// AC-23: staff must never run campaigns
// ---------------------------------------------------------------------------

test('AC-23: staff cannot create, approve or send campaigns (403)', async () => {
  const owner = await login('ac23-owner');
  const staff = await login('ac23-staff');
  const eventId = await createEvent(owner);
  await sql`
    INSERT INTO organizer_members (organizer_id, account_id, role)
    SELECT e.organizer_id, ${staff.accountId}, 'staff' FROM events e WHERE e.id = ${eventId}
  `;

  const createRes = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'organizer_marketing', body_text: 'hello' },
      cookie: staff.cookie,
    }),
  );
  assertStatus(createRes, 403);

  const created = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'organizer_marketing', body_text: 'hello' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(created, 201);
  const campaignId = ((await created.json()) as { campaign: { id: string } }).campaign.id;

  const approveRes = await approveRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: staff.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(approveRes, 403);

  // Approve as owner so the staff send attempt hits the send gate.
  await approveRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  const sendRes = await sendRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/send`, { body: {}, cookie: staff.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(sendRes, 403);
});

test('campaigns: cross-organizer access is 404 (no existence leak)', async () => {
  const stranger = await login('ac22-stranger');
  const owner = await login('ac22-owner');
  const eventId = await createEvent(owner);
  const created = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'service_channel', body_text: 'x' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(created, 201);
  const id = ((await created.json()) as { campaign: { id: string } }).campaign.id;
  const res = await approveRoute(
    makeRequest(`/api/organizer/campaigns/${id}/approve`, { body: {}, cookie: stranger.cookie }),
    { params: Promise.resolve({ id }) },
  );
  assertStatus(res, 404);
});

// ---------------------------------------------------------------------------
// Full flow: audience → approve → AC-40 edit reset → AC-41 revalidation → send → outcomes → stats
// ---------------------------------------------------------------------------

test('campaign flow: preview, approve snapshot, edit resets approval, send revalidates, worker delivers', async () => {
  const owner = await login('flow-owner');
  const a = await login('flow-a');
  const b = await login('flow-b');
  const c = await login('flow-c');
  const d = await login('flow-d');
  const eventId = await createEvent(owner);
  await addMember(eventId, a, { visible: true });
  await addMember(eventId, b, { visible: true });
  await addMember(eventId, c, { visible: true });
  await addMember(eventId, d, { visible: true });
  await bindTelegram(a.accountId, '888000001');
  await bindTelegram(c.accountId, '888000003');
  // d: consented but has NO channel at all → suppressed no_channel at send.
  // b: consented for now, binding deliberately absent too.
  for (const u of [a, b, c, d]) {
    await grantConsent(u.accountId, 'organizer_marketing', 'event', eventId);
  }

  const created = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'organizer_marketing', body_text: 'Welcome to the afterparty!' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(created, 201);
  const campaignId = ((await created.json()) as { campaign: { id: string } }).campaign.id;

  // Audience preview: count + display-name-only sample.
  const preview = await audienceRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/audience`, { cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(preview, 200);
  const previewBody = (await preview.json()) as {
    audience: { count: number; sample: { display_name: string }[]; channel_ready: number };
  };
  assert.equal(previewBody.audience.count, 4, 'all four members granted consent');
  assert.equal(previewBody.audience.channel_ready, 2, 'a and c have active bindings; b and d none');
  assert.equal(previewBody.audience.sample.length, 4);
  assert.ok(Object.keys(previewBody.audience.sample[0]!).every((k) => k === 'display_name'), 'no contacts in sample');

  // Approve (owner only) → snapshot frozen, approved_revision = content_revision.
  const approve = await approveRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(approve, 200);
  const approveBody = (await approve.json()) as { campaign: { approved_revision: number | null }; audience_count: number };
  assert.equal(approveBody.audience_count, 4);
  assert.equal(approveBody.campaign.approved_revision, 1);
  const snapshot = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM campaign_audience WHERE campaign_id = ${campaignId}
  `;
  assert.equal(snapshot[0]!.count, 4);

  // AC-40: edit after approve → approval reset.
  const edit = await editCampaignRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}`, {
      body: { body_text: 'Updated afterparty text' },
      cookie: owner.cookie,
    }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(edit, 200);
  const afterEdit = (await edit.json()) as { campaign: { state: string; content_revision: number; approved_revision: number | null } };
  assert.equal(afterEdit.campaign.state, 'draft');
  assert.equal(afterEdit.campaign.content_revision, 2);
  assert.equal(afterEdit.campaign.approved_revision, null);

  // Send while draft → 409.
  const earlySend = await sendRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/send`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(earlySend, 409);

  // Re-approve revision 2.
  const reApprove = await approveRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(reApprove, 200);
  assert.equal(((await reApprove.json()) as { campaign: { approved_revision: number } }).campaign.approved_revision, 2);

  // AC-41: b revokes consent AFTER approve — the frozen snapshot cannot bypass it.
  await withdrawConsent(b.accountId, 'organizer_marketing', 'event', eventId);
  const send = await sendRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/send`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(send, 202);
  const sendBody = (await send.json()) as { queued: number };
  assert.equal(sendBody.queued, 3, 'b excluded by live revalidation before enqueue');

  const bJob = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs
    WHERE dedupe_key = ${`campaign:${campaignId}:${b.accountId}`}
  `;
  assert.equal(bJob[0]!.count, 0, 'no job created for the revoked member');

  // Worker: a and c (bound) are sent; d (no channel at all) suppressed no_channel.
  const mock = new MockTelegramTransport();
  await drainWorker(mock);
  for (const u of [a, c]) {
    const jobId = (
      await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`campaign:${campaignId}:${u.accountId}`}`
    )[0]!.id;
    assert.equal((await jobRow(jobId)).status, 'sent');
  }
  const dJobId = (
    await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`campaign:${campaignId}:${d.accountId}`}`
  )[0]!.id;
  const dJob = await jobRow(dJobId);
  assert.equal(dJob.status, 'suppressed');
  assert.equal((await attemptRows(dJobId))[0]!.code, 'no_channel');
  assert.equal(mock.sent[0]!.text, 'Updated afterparty text', 'message body is the approved content');

  // Stats: live counters by status; sent ≠ delivered.
  const stats = await statsRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/stats`, { cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(stats, 200);
  const statsBody = (await stats.json()) as {
    counters: Record<string, number>;
    campaign: unknown;
    note: string;
  };
  assert.equal(statsBody.counters['sent'], 2);
  assert.equal(statsBody.counters['suppressed'], 1);
  assert.equal(statsBody.counters['pending'], 0);
  assert.match(statsBody.note, /delivered is never claimed/i);
});

// ---------------------------------------------------------------------------
// AC-25 end-to-end: withdraw while queued → suppressed; the rest still sent
// ---------------------------------------------------------------------------

test('AC-25: consent withdrawn while job queued → suppressed without send; others sent', async () => {
  const owner = await login('ac25-owner');
  const x = await login('ac25-x');
  const y = await login('ac25-y');
  const eventId = await createEvent(owner);
  await addMember(eventId, x, { visible: true });
  await addMember(eventId, y, { visible: true });
  await bindTelegram(x.accountId, '888100001');
  await bindTelegram(y.accountId, '888100002');
  for (const u of [x, y]) {
    await grantConsent(u.accountId, 'service_channel', 'event', eventId);
  }

  const created = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'service_channel', body_text: 'Service notice: venue changed' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(created, 201);
  const campaignId = ((await created.json()) as { campaign: { id: string } }).campaign.id;

  await approveRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  const send = await sendRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/send`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(send, 202);
  assert.equal(((await send.json()) as { queued: number }).queued, 2);

  // x withdraws service_channel while their job is pending — through the REAL
  // revoke route so the transactional suppression hook (AC-25) runs.
  const revoke = await revokeConsentRoute(
    makeRequest('/api/consents/revoke', {
      body: { purpose: 'service_channel', scope_type: 'event', scope_id: eventId, policy_version: '2026-09-07' },
      cookie: x.cookie,
    }),
  );
  assertStatus(revoke, 200);
  const xJobId = (
    await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`campaign:${campaignId}:${x.accountId}`}`
  )[0]!.id;
  assert.equal((await jobRow(xJobId)).status, 'suppressed', 'revoke suppresses the queued job inside the withdrawal');

  // Worker delivers y only.
  const mock = new MockTelegramTransport();
  await tickOnce({ transport: mock });
  assert.equal(mock.sendCount, 1, 'only the consenting recipient was messaged');
  assert.equal(mock.sent[0]!.chatId, '888100002');
  const yJob = await jobRow(
    (await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`campaign:${campaignId}:${y.accountId}`}`)[0]!.id,
  );
  assert.equal(yJob.status, 'sent');
});

// ---------------------------------------------------------------------------
// Intro notices: transactional outbox + AC-25 for service_channel withdrawal
// ---------------------------------------------------------------------------

test('intro notices: requested notice enqueued transactionally; withdrawal suppresses it (AC-25)', async () => {
  const initiator = await login('intro-i');
  const target = await login('intro-t');
  const eventId = await createEvent(await login('intro-org'));
  await addMember(eventId, initiator, { visible: true });
  await addMember(eventId, target, { visible: true });
  await grantConsent(target.accountId, 'service_channel', 'global', null);
  await bindTelegram(target.accountId, '888200001');

  const res = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: target.profileId, event_id: eventId },
      cookie: initiator.cookie,
    }),
  );
  assertStatus(res, 200);
  const introId = ((await res.json()) as { introduction: { id: string } }).introduction.id;

  const notice = await sql<{ id: string; status: string; payload: Record<string, unknown> }[]>`
    SELECT id, status, payload FROM outbox_jobs WHERE dedupe_key = ${`intro_requested:${introId}:${target.accountId}`}
  `;
  assert.ok(notice[0], 'requested notice enqueued in the same transaction');
  assert.equal(notice[0]!.payload['enforce_consent'], true);
  const text = String(notice[0]!.payload['text']);
  assert.ok(!text.includes('@'), 'no contact handles in the notice body');

  // Target withdraws service_channel through the real revoke route → the
  // queued notice is suppressed inside the withdrawal transaction.
  const revoke = await revokeConsentRoute(
    makeRequest('/api/consents/revoke', {
      body: { purpose: 'service_channel', scope_type: 'global', policy_version: '2026-09-07' },
      cookie: target.cookie,
    }),
  );
  assertStatus(revoke, 200);
  assert.equal((await jobRow(notice[0]!.id)).status, 'suppressed');

  // Mutual accept later enqueues one notice per side (fresh, not suppressed).
  const accept = await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, {
      body: { decision: 'accept', reveal_fields: [] },
      cookie: target.cookie,
    }),
    { params: Promise.resolve({ id: introId }) },
  );
  assertStatus(accept, 200);
  const accept2 = await respondIntroRoute(
    makeRequest(`/api/introductions/${introId}/respond`, {
      body: { decision: 'accept', reveal_fields: [] },
      cookie: initiator.cookie,
    }),
    { params: Promise.resolve({ id: introId }) },
  );
  assertStatus(accept2, 200);
  const state = ((await accept2.json()) as { introduction: { state: string } }).introduction.state;
  assert.equal(state, 'mutual');

  const mutualNotices = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs WHERE dedupe_key LIKE ${`intro_mutual:${introId}:%`}
  `;
  assert.equal(mutualNotices[0]!.count, 2, 'exactly one mutual notice per side');
  const bodies = await sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM outbox_jobs WHERE dedupe_key LIKE ${`intro_mutual:${introId}:%`}
  `;
  for (const row of bodies) {
    assert.ok(!String(row.payload['text']).includes('+79'), 'no phone values in mutual notice');
  }
});

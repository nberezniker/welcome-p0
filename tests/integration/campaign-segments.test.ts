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
import { POST as revokeConsentRoute } from '../../src/app/api/consents/revoke/route';
import { getSql, closeSql } from '../../src/lib/db';
import { MockTelegramTransport } from '../../src/integrations/telegram/mock-transport';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';
import { bindTelegram, drainWorker, grantConsent, withdrawConsent } from './phase3-helpers';

/**
 * Campaign audience segments (audience_filter).
 *
 * A segment narrows the eligible audience on the taxonomy v3 axes. The three
 * guarantees under test:
 *   1. only matching members are selected (non-matching consenting members are
 *      not);
 *   2. the preview COUNT equals the number of jobs `send` actually enqueues —
 *      the organizer sizes exactly what goes out;
 *   3. a consent withdrawal between approve and send still excludes the member
 *      (AC-41), whatever the segment says.
 */

after(async () => {
  await closeSql();
});

const sql = getSql();

interface Actor {
  cookie: string;
  accountId: string;
  profileId: string;
}

async function login(prefix: string, axes: Record<string, unknown> = {}): Promise<Actor> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `Segment ${prefix}`, languages: ['en'], offer_tags: [], need_tags: [], ...axes },
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
      body: { name: 'Segment Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string } }).event.id;
}

async function addMember(eventId: string, member: Actor): Promise<void> {
  const res = await joinRoute(
    makeRequest(`/api/events/${eventId}/join`, { body: {}, cookie: member.cookie }),
    { params: Promise.resolve({ eventIdOrSlug: eventId }) },
  );
  assertStatus(res, 200);
  await sql`UPDATE event_memberships SET directory_visible = true WHERE event_id = ${eventId} AND profile_id = ${member.profileId}`;
}

interface AudiencePreview {
  count: number;
  channel_ready: number;
  sample: { display_name: string }[];
  filter: Record<string, unknown>;
  segment: boolean;
}

async function audience(campaignId: string, owner: Actor, query = ''): Promise<AudiencePreview> {
  const res = await audienceRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/audience${query}`, { cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(res, 200);
  return ((await res.json()) as { audience: AudiencePreview }).audience;
}

test('segments: a filter selects only matching members, and the preview count equals the queued jobs', async () => {
  const owner = await login('seg-owner');
  const matchA = await login('seg-a', { need_intents: ['seeking-cofounder'], interests: ['ai-ml'], industry: 'ai-saas' });
  const matchB = await login('seg-b', { need_intents: ['seeking-cofounder'], interests: ['ai-ml', 'saas'] });
  const otherTopic = await login('seg-c', { need_intents: ['seeking-cofounder'], interests: ['ux-ui'] });
  const otherIntent = await login('seg-d', { need_intents: ['hiring'], interests: ['ai-ml'] });
  const eventId = await createEvent(owner);
  for (const u of [matchA, matchB, otherTopic, otherIntent]) {
    await addMember(eventId, u);
    await grantConsent(u.accountId, 'organizer_marketing', 'event', eventId);
    await bindTelegram(u.accountId, `seg-${u.profileId.slice(0, 8)}`);
  }

  const created = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: {
        event_id: eventId,
        purpose: 'organizer_marketing',
        body_text: 'Segment-only afterparty',
        audience_filter: { need_intents: ['seeking-cofounder'], interests: ['ai-ml'] },
      },
      cookie: owner.cookie,
    }),
  );
  assertStatus(created, 201);
  const campaignId = ((await created.json()) as { campaign: { id: string } }).campaign.id;

  // Unsegmented control: WITHOUT the filter all four members are eligible.
  const edit = await editCampaignRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}`, {
      body: { audience_filter: {} },
      cookie: owner.cookie,
    }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(edit, 200);
  const all = await audience(campaignId, owner);
  assert.equal(all.count, 4, 'an empty filter reaches every eligible member');
  assert.equal(all.segment, false);
  assert.equal(all.channel_ready, 4);

  // Now save the segment (an edit resets the approval — AC-40).
  const segmented = await editCampaignRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}`, {
      body: { audience_filter: { need_intents: ['seeking-cofounder'], interests: ['ai-ml'] } },
      cookie: owner.cookie,
    }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(segmented, 200);
  assert.equal(
    ((await segmented.json()) as { campaign: { approved_revision: number | null; state: string } }).campaign.state,
    'draft',
    'changing the segment invalidates the approval',
  );

  const preview = await audience(campaignId, owner);
  assert.equal(preview.count, 2, 'only members matching BOTH axes are in the segment');
  assert.equal(preview.segment, true);
  assert.equal(preview.channel_ready, 2);
  assert.deepEqual(preview.filter['need_intents'], ['seeking-cofounder']);
  assert.deepEqual(preview.filter['interests'], ['ai-ml']);
  assert.deepEqual(
    preview.sample.map((s) => s.display_name).sort(),
    ['Segment seg-a', 'Segment seg-b'],
    'the sample is exactly the segment',
  );
  assert.ok(preview.sample.every((s) => Object.keys(s).join() === 'display_name'), 'no contacts in the sample');

  // Unsaved segment via query overrides (the form previews before saving).
  const unsaved = await audience(campaignId, owner, '?need_intents=hiring&interests=ai-ml');
  assert.equal(unsaved.count, 1, 'the override sizes an unsaved segment');
  assert.deepEqual(unsaved.filter['need_intents'], ['hiring']);
  const invalid = await audienceRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/audience?interests=not-a-topic`, { cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(invalid, 400);
  assert.equal(((await invalid.json()) as { code: string }).code, 'invalid_audience_filter');

  // Approve freezes the SEGMENTED audience, send queues exactly that many jobs.
  assertStatus(
    await approveRoute(
      makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: owner.cookie }),
      { params: Promise.resolve({ id: campaignId }) },
    ),
    200,
  );
  const snapshot = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM campaign_audience WHERE campaign_id = ${campaignId}
  `;
  assert.equal(snapshot[0]!.count, 2, 'the snapshot is the segment, not the whole event');

  const send = await sendRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/send`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(send, 202);
  const queued = ((await send.json()) as { queued: number }).queued;
  assert.equal(queued, preview.count, 'preview count == jobs created');

  const jobs = await sql<{ account_id: string }[]>`
    SELECT payload->>'account_id' AS account_id FROM outbox_jobs
    WHERE kind = 'campaign_message' AND payload->>'campaign_id' = ${campaignId}
  `;
  assert.deepEqual(
    jobs.map((j) => j.account_id).sort(),
    [matchA.accountId, matchB.accountId].sort(),
    'only the segmented members got a job',
  );

  // Leave no deliverable job behind: suites share one DB, and a later suite
  // asserting on its own first send must not trip over a foreign leftover.
  await drainWorker(new MockTelegramTransport());
});

test('segments: revoking consent after approve excludes the member even inside the segment', async () => {
  const owner = await login('seg2-owner');
  const keeper = await login('seg2-keeper', { interests: ['dev-tools'] });
  const leaver = await login('seg2-leaver', { interests: ['dev-tools'] });
  const eventId = await createEvent(owner);
  for (const u of [keeper, leaver]) {
    await addMember(eventId, u);
    await grantConsent(u.accountId, 'organizer_marketing', 'event', eventId);
    await bindTelegram(u.accountId, `seg2-${u.profileId.slice(0, 8)}`);
  }

  const created = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: {
        event_id: eventId,
        purpose: 'organizer_marketing',
        body_text: 'Segment + revoke',
        audience_filter: { interests: ['dev-tools'] },
      },
      cookie: owner.cookie,
    }),
  );
  assertStatus(created, 201);
  const campaignId = ((await created.json()) as { campaign: { id: string } }).campaign.id;

  const preview = await audience(campaignId, owner);
  assert.equal(preview.count, 2);

  assertStatus(
    await approveRoute(
      makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: owner.cookie }),
      { params: Promise.resolve({ id: campaignId }) },
    ),
    200,
  );

  // AC-41: the withdrawal lands after the snapshot was frozen.
  assertStatus(
    await revokeConsentRoute(
      makeRequest('/api/consents/revoke', {
        body: { purpose: 'organizer_marketing', scope_type: 'event', scope_id: eventId, policy_version: '2026-09-07' },
        cookie: leaver.cookie,
      }),
    ),
    200,
  );
  // Belt and braces: an explicit withdraw row too (the revoke route writes one).
  await withdrawConsent(leaver.accountId, 'organizer_marketing', 'event', eventId);

  const send = await sendRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/send`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(send, 202);
  assert.equal(((await send.json()) as { queued: number }).queued, 1, 'the revoked member is excluded from the segment too');

  const jobs = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs
    WHERE kind = 'campaign_message' AND payload->>'campaign_id' = ${campaignId}
      AND payload->>'account_id' = ${leaver.accountId}
  `;
  assert.equal(jobs[0]!.count, 0, 'no job for the member who withdrew');

  await drainWorker(new MockTelegramTransport());
});

test('segments: an invalid segment on create or edit is rejected with 400', async () => {
  const owner = await login('seg3-owner');
  const eventId = await createEvent(owner);

  const badCreate = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: {
        event_id: eventId,
        purpose: 'service_channel',
        body_text: 'x',
        audience_filter: { industry: 'not-an-industry' },
      },
      cookie: owner.cookie,
    }),
  );
  assertStatus(badCreate, 400);
  assert.equal(((await badCreate.json()) as { code: string }).code, 'invalid_industry');

  const good = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'service_channel', body_text: 'x' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(good, 201);
  const campaignId = ((await good.json()) as { campaign: { id: string } }).campaign.id;

  const badEdit = await editCampaignRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}`, {
      body: { audience_filter: { interests: ['definitely-not-a-topic'] } },
      cookie: owner.cookie,
    }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(badEdit, 400);

  // The campaign is untouched by the rejected edits.
  const rows = await sql<{ audience_filter: Record<string, unknown>; content_revision: number }[]>`
    SELECT audience_filter, content_revision::int AS content_revision FROM campaigns WHERE id = ${campaignId}
  `;
  assert.equal(rows[0]!.content_revision, 1);
  assert.deepEqual(rows[0]!.audience_filter, {
    need_intents: [],
    offer_intents: [],
    interests: [],
    job_function: null,
    industry: null,
  });
});

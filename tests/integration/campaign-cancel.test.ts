import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { POST as createCampaignRoute } from '../../src/app/api/organizer/campaigns/route';
import { POST as approveRoute } from '../../src/app/api/organizer/campaigns/[id]/approve/route';
import { POST as sendRoute } from '../../src/app/api/organizer/campaigns/[id]/send/route';
import { POST as cancelRoute } from '../../src/app/api/organizer/campaigns/[id]/cancel/route';
import { GET as statsRoute } from '../../src/app/api/organizer/campaigns/[id]/stats/route';
import { PATCH as editRoute } from '../../src/app/api/organizer/campaigns/[id]/route';
import { getSql, closeSql } from '../../src/lib/db';
import { tickOnce } from '../../src/infra/worker';
import { MockTelegramTransport } from '../../src/integrations/telegram/mock-transport';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';
import { bindTelegram, grantConsent, drainWorker, jobRow, attemptRows } from './phase3-helpers';

after(async () => {
  await closeSql();
});

const sql = getSql();

/**
 * THE STOP BUTTON: `running → cancelled`, and the honest semantics behind it.
 *
 * THE DEFECT THIS SUITE PINS. `cancelled` was declared in the state union, the
 * `campaigns_state_check` constraint, the UI labels and the immutability guard,
 * and no code path could reach it. An organizer who approved a campaign by mistake
 * had no way to stop the sends it was about to queue: `canSend` requires
 * `approved`, the edit path treats `running` as immutable, and there was no cancel
 * endpoint at all. A tool that messages real people needs a stop button.
 *
 * WHAT IS ASSERTED, one file, six angles — each a way the feature could be
 * implemented and still be wrong:
 *   1. the transition itself: running → cancelled, with the queued jobs
 *      suppressed (and an attempt row per job, so the suppression is recorded
 *      rather than silent);
 *   2. what a cancel does NOT do: a job already accepted by the channel stays
 *      'sent' — "anything already sent stays sent" is a claim about the rows, not
 *      about the response body;
 *   3. the audit row, with the numbers it reports;
 *   4. cross-organizer access is 404 (NOT 403 — no existence leak), and staff is
 *      403 (the same people who can start a send can stop one);
 *   5. cancelling twice is a no-op, not an error, and does not write a second
 *      audit row;
 *   6. the states where cancelling is impossible: draft/approved (nothing is
 *      queued) and completed (already drained) are 409 with the state named.
 */

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
      body: { display_name: `Cancel ${prefix}`, languages: ['en'], offer_tags: [], need_tags: [] },
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
      body: { name: 'Cancel Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string } }).event.id;
}

async function addMember(eventId: string, member: Actor, opts: { visible?: boolean } = {}): Promise<void> {
  const joined = await joinRoute(makeRequest(`/api/events/${eventId}/join`, { body: {}, cookie: member.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: eventId }),
  });
  assertStatus(joined, 200);
  if (opts.visible) {
    await sql`
      UPDATE event_memberships SET directory_visible = true
      WHERE event_id = ${eventId} AND profile_id = ${member.profileId}
    `;
  }
}

async function createApprovedCampaign(owner: Actor, eventId: string, bodyText: string): Promise<string> {
  const created = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'service_channel', body_text: bodyText },
      cookie: owner.cookie,
    }),
  );
  assertStatus(created, 201);
  const campaignId = ((await created.json()) as { campaign: { id: string } }).campaign.id;
  const approve = await approveRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(approve, 200);
  return campaignId;
}

async function sendCampaign(owner: Actor, campaignId: string): Promise<{ queued: number; state: string }> {
  const res = await sendRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/send`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(res, 202);
  return (await res.json()) as { queued: number; state: string };
}

function cancel(actor: Actor, campaignId: string) {
  return cancelRoute(makeRequest(`/api/organizer/campaigns/${campaignId}/cancel`, { body: {}, cookie: actor.cookie }), {
    params: Promise.resolve({ id: campaignId }),
  });
}

async function campaignState(campaignId: string): Promise<string> {
  const rows = await sql<{ state: string }[]>`SELECT state FROM campaigns WHERE id = ${campaignId}`;
  return rows[0]!.state;
}

async function campaignAuditRows(campaignId: string, action: string) {
  return sql<{ id: string; metadata: Record<string, unknown> }[]>`
    SELECT id, metadata FROM audit_events
    WHERE action = ${action} AND target_type = 'campaign' AND target_id = ${campaignId}
    ORDER BY created_at ASC
  `;
}

async function jobIdOf(campaignId: string, accountId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM outbox_jobs WHERE dedupe_key = ${`campaign:${campaignId}:${accountId}`}
  `;
  assert.ok(rows[0], 'the job must exist');
  return rows[0]!.id;
}

/** The status of every job this campaign queued — "did the refusal touch work?" */
async function jobIdStatuses(campaignId: string): Promise<string[]> {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM outbox_jobs
    WHERE kind = 'campaign_message' AND payload->>'campaign_id' = ${campaignId}
    ORDER BY dedupe_key
  `;
  return rows.map((r) => r.status);
}

// ---------------------------------------------------------------------------

test('cancel: running → cancelled suppresses the queue it had not delivered', async () => {
  const owner = await login('cancel-owner');
  const a = await login('cancel-a');
  const b = await login('cancel-b');
  const eventId = await createEvent(owner);
  await addMember(eventId, a, { visible: true });
  await addMember(eventId, b, { visible: true });
  await bindTelegram(a.accountId, '887000001');
  await bindTelegram(b.accountId, '887000002');
  for (const u of [a, b]) {
    await grantConsent(u.accountId, 'service_channel', 'event', eventId);
  }

  const campaignId = await createApprovedCampaign(owner, eventId, 'This one must never leave the building');
  const sent = await sendCampaign(owner, campaignId);
  assert.equal(sent.queued, 2, 'both consented members are queued');
  assert.equal(await campaignState(campaignId), 'running');
  const aJob = await jobIdOf(campaignId, a.accountId);
  const bJob = await jobIdOf(campaignId, b.accountId);
  assert.equal((await jobRow(aJob)).status, 'pending');
  assert.equal((await jobRow(bJob)).status, 'pending');

  const res = await cancel(owner, campaignId);
  assertStatus(res, 200);
  const body = (await res.json()) as { campaign: { state: string }; suppressed: number; sent: number; already_cancelled: boolean };
  assert.equal(body.campaign.state, 'cancelled');
  assert.equal(body.suppressed, 2, 'both queued jobs were suppressed');
  assert.equal(body.sent, 0, 'nothing had been sent yet, and the response says so');
  assert.equal(body.already_cancelled, false);
  assert.equal(await campaignState(campaignId), 'cancelled', 'the row says it too, not just the endpoint');

  // Suppressed, not dropped: each job carries its outcome code.
  for (const jobId of [aJob, bJob]) {
    assert.equal((await jobRow(jobId)).status, 'suppressed');
    assert.equal((await attemptRows(jobId))[0]!.code, 'campaign_cancelled');
  }

  // And the worker really cannot revive them: a full drain attempts nothing.
  const mock = new MockTelegramTransport();
  await drainWorker(mock);
  assert.equal(mock.sendCount, 0, 'no message was attempted after the cancel');
  for (const jobId of [aJob, bJob]) assert.equal((await jobRow(jobId)).status, 'suppressed');

  // The campaign stays cancelled — the drain must not re-classify it as completed.
  assert.equal(await campaignState(campaignId), 'cancelled');

  // Stats agree with the rows.
  const stats = await statsRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/stats`, { cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(stats, 200);
  const statsBody = (await stats.json()) as { counters: Record<string, number>; state: string; drained: boolean };
  assert.equal(statsBody.counters['suppressed'], 2);
  assert.equal(statsBody.counters['pending'], 0);
  assert.equal(statsBody.state, 'cancelled');
});

test('cancel: the audit row carries the numbers the response reported', async () => {
  const owner = await login('cancel-audit-owner');
  const member = await login('cancel-audit-member');
  const eventId = await createEvent(owner);
  await addMember(eventId, member, { visible: true });
  await bindTelegram(member.accountId, '887100001');
  await grantConsent(member.accountId, 'service_channel', 'event', eventId);

  const campaignId = await createApprovedCampaign(owner, eventId, 'Audited stop');
  await sendCampaign(owner, campaignId);
  const res = await cancel(owner, campaignId);
  assertStatus(res, 200);
  const body = (await res.json()) as { suppressed: number; sent: number };

  const rows = await campaignAuditRows(campaignId, 'campaign.cancel');
  assert.equal(rows.length, 1, 'exactly one audit row for the transition');
  assert.equal(rows[0]!.metadata['suppressed'], body.suppressed);
  assert.equal(rows[0]!.metadata['sent'], body.sent);
  assert.equal(rows[0]!.metadata['queued_count'], 1);

  // A cancel is not a send and not an edit: it must not write their rows.
  assert.equal((await campaignAuditRows(campaignId, 'campaign.send')).length, 1);
  assert.equal((await campaignAuditRows(campaignId, 'campaign.edit')).length, 0);
});

test('cancel: anything already sent stays sent, and the response says which of the two happened', async () => {
  const owner = await login('cancel-mixed-owner');
  const early = await login('cancel-mixed-early');
  const late = await login('cancel-mixed-late');
  const eventId = await createEvent(owner);
  await addMember(eventId, early, { visible: true });
  await addMember(eventId, late, { visible: true });
  await bindTelegram(early.accountId, '887200001');
  await bindTelegram(late.accountId, '887200002');
  for (const u of [early, late]) {
    await grantConsent(u.accountId, 'service_channel', 'event', eventId);
  }

  const campaignId = await createApprovedCampaign(owner, eventId, 'Half of this will go out');
  await sendCampaign(owner, campaignId);
  const earlyJob = await jobIdOf(campaignId, early.accountId);
  const lateJob = await jobIdOf(campaignId, late.accountId);

  // ONE tick with a SCRIPTED transport: the first send is accepted, the second
  // times out (a timeout under the attempt cap is re-queued with backoff, so that
  // recipient is still `pending`). That is the split this test needs — one message
  // already at the channel, one still ours to stop — produced by the real worker
  // and the real outcome mapping, not by writing a status into the table. Which
  // member got which job is not asserted: the campaign_audience order is the
  // database's, so the test reads the statuses and names the two jobs from them.
  const mock = new MockTelegramTransport([
    { state: 'sent', providerMessageId: 'mock-accepted' },
    { state: 'unknown', code: 'timeout' },
  ]);
  await tickOnce({ transport: mock });
  assert.equal(mock.sendCount, 2, 'both queued recipients were attempted');

  const statuses = { early: (await jobRow(earlyJob)).status, late: (await jobRow(lateJob)).status };
  const sentJobId = statuses.early === 'sent' ? earlyJob : lateJob;
  const queuedJobId = statuses.early === 'sent' ? lateJob : earlyJob;
  assert.equal((await jobRow(sentJobId)).status, 'sent', `expected one job sent, got ${JSON.stringify(statuses)}`);
  assert.equal((await jobRow(queuedJobId)).status, 'pending', `expected one job still queued, got ${JSON.stringify(statuses)}`);

  const before = await sql<{ sent_count: number }[]>`SELECT sent_count FROM campaigns WHERE id = ${campaignId}`;
  assert.equal(before[0]!.sent_count, 1, 'the accepted message is counted before the cancel');

  const res = await cancel(owner, campaignId);
  assertStatus(res, 200);
  const body = (await res.json()) as { suppressed: number; sent: number };
  assert.equal(body.suppressed, 1, 'the queued message was suppressed');
  assert.equal(body.sent, 1, 'and the response reports what had already gone out');

  assert.equal((await jobRow(sentJobId)).status, 'sent', 'a cancel cannot unsend: the accepted message stays sent');
  assert.equal((await jobRow(queuedJobId)).status, 'suppressed');
  assert.equal((await attemptRows(sentJobId))[0]!.state, 'sent');
});

test('cancel: cross-organizer access is 404, staff is 403', async () => {
  const owner = await login('cancel-authz-owner');
  const stranger = await login('cancel-authz-stranger');
  const staff = await login('cancel-authz-staff');
  const member = await login('cancel-authz-member');
  const eventId = await createEvent(owner);
  await addMember(eventId, member, { visible: true });
  await bindTelegram(member.accountId, '887500001');
  await grantConsent(member.accountId, 'service_channel', 'event', eventId);
  await sql`
    INSERT INTO organizer_members (organizer_id, account_id, role)
    SELECT e.organizer_id, ${staff.accountId}, 'staff' FROM events e WHERE e.id = ${eventId}
  `;
  const campaignId = await createApprovedCampaign(owner, eventId, 'Owned by somebody else');
  const sent = await sendCampaign(owner, campaignId);
  assert.equal(sent.queued, 1, 'the fixture has one reachable recipient, so there is something to stop');
  assert.equal(await campaignState(campaignId), 'running');

  // A stranger must not learn that this campaign exists: 404, not 403 — the same
  // answer the approve/send/stats routes give (loadCampaignWithRole role=null).
  const strangerRes = await cancel(stranger, campaignId);
  assertStatus(strangerRes, 404);
  assert.equal(((await strangerRes.json()) as { code: string }).code, 'not_found');
  assert.equal(await campaignState(campaignId), 'running', 'a refused cancel changes nothing');
  assert.equal((await jobIdStatuses(campaignId)).join(','), 'pending', 'and it suppresses nothing either');

  // Staff can see the console but may not start or stop sends.
  const staffRes = await cancel(staff, campaignId);
  assertStatus(staffRes, 403);
  assert.equal(await campaignState(campaignId), 'running');
  assert.equal((await jobIdStatuses(campaignId)).join(','), 'pending');

  // A non-uuid id is the same 404 (no parse error, no existence oracle).
  const junkRes = await cancel(owner, 'not-a-uuid');
  assertStatus(junkRes, 404);
});

test('cancel: cancelling twice is a no-op, not an error, and writes no second audit row', async () => {
  const owner = await login('cancel-twice-owner');
  const member = await login('cancel-twice-member');
  const eventId = await createEvent(owner);
  await addMember(eventId, member, { visible: true });
  await bindTelegram(member.accountId, '887300001');
  await grantConsent(member.accountId, 'service_channel', 'event', eventId);

  const campaignId = await createApprovedCampaign(owner, eventId, 'Stop me twice');
  await sendCampaign(owner, campaignId);
  const first = await cancel(owner, campaignId);
  assertStatus(first, 200);
  const firstBody = (await first.json()) as { suppressed: number; already_cancelled: boolean };
  assert.equal(firstBody.suppressed, 1);
  assert.equal(firstBody.already_cancelled, false);

  const second = await cancel(owner, campaignId);
  assertStatus(second, 200);
  const secondBody = (await second.json()) as {
    suppressed: number;
    already_cancelled: boolean;
    campaign: { state: string };
  };
  assert.equal(secondBody.already_cancelled, true, 'the outcome the caller asked for is already true');
  assert.equal(secondBody.suppressed, 0, 'nothing was suppressed a second time');
  assert.equal(secondBody.campaign.state, 'cancelled');
  assert.equal(await campaignState(campaignId), 'cancelled');
  assert.equal((await campaignAuditRows(campaignId, 'campaign.cancel')).length, 1, 'one transition, one audit row');
});

test('cancel: draft, approved and completed are refused with the state named', async () => {
  const owner = await login('cancel-states-owner');
  const member = await login('cancel-states-member');
  const eventId = await createEvent(owner);
  await addMember(eventId, member, { visible: true });
  await bindTelegram(member.accountId, '887400001');
  await grantConsent(member.accountId, 'service_channel', 'event', eventId);

  // draft: nothing has been queued, so there is nothing to stop.
  const created = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'service_channel', body_text: 'Still a draft' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(created, 201);
  const draftId = ((await created.json()) as { campaign: { id: string } }).campaign.id;
  const draftRes = await cancel(owner, draftId);
  assertStatus(draftRes, 409);
  const draftBody = (await draftRes.json()) as { code: string; message: string };
  assert.equal(draftBody.code, 'invalid_state');
  assert.match(draftBody.message, /draft/, 'the refusal names the state it refused');
  assert.equal(await campaignState(draftId), 'draft');

  // approved: still nothing queued — and it can be edited back to draft, which is
  // the honest alternative, so `cancelled` here would report a stop that stopped
  // nothing.
  const approvedId = await createApprovedCampaign(owner, eventId, 'Approved but never sent');
  const approvedRes = await cancel(owner, approvedId);
  assertStatus(approvedRes, 409);
  assert.equal(await campaignState(approvedId), 'approved');
  // The alternative really is there: an edit resets the approval.
  const edited = await editRoute(
    makeRequest(`/api/organizer/campaigns/${approvedId}`, {
      body: { body_text: 'Changed my mind' },
      cookie: owner.cookie,
    }),
    { params: Promise.resolve({ id: approvedId }) },
  );
  assertStatus(edited, 200);
  assert.equal(await campaignState(approvedId), 'draft');

  // completed: EVERY recipient reached a terminal outcome, so there is nothing
  // left to stop — the "already drained" case. The campaign is drained by the
  // real drain path (the member has no channel at all → suppressed no_channel).
  const doneId = await createApprovedCampaign(owner, eventId, 'This one drains itself');
  const sent = await sendCampaign(owner, doneId);
  assert.equal(sent.queued, 1);
  assert.equal(await campaignState(doneId), 'running');
  await drainWorker(new MockTelegramTransport());
  assert.equal(await campaignState(doneId), 'completed', 'a terminal recipient completes the campaign');
  const doneRes = await cancel(owner, doneId);
  assertStatus(doneRes, 409);
  const doneBody = (await doneRes.json()) as { code: string; message: string };
  assert.equal(doneBody.code, 'invalid_state');
  assert.match(doneBody.message, /completed/);
  assert.equal(await campaignState(doneId), 'completed', 'a refused cancel must not rewrite a finished campaign');

  // The completed behaviour itself is untouched: it stays completed and uneditable.
  const editDone = await editRoute(
    makeRequest(`/api/organizer/campaigns/${doneId}`, { body: { body_text: 'nope' }, cookie: owner.cookie }),
    { params: Promise.resolve({ id: doneId }) },
  );
  assertStatus(editDone, 409);
  assert.equal(await campaignState(doneId), 'completed');
});

test('cancel: a member (no organizer role) gets 401/404, never a role bypass', async () => {
  const owner = await login('cancel-member-owner');
  const member = await login('cancel-plain-member');
  const eventId = await createEvent(owner);
  await addMember(eventId, member, { visible: true });
  await bindTelegram(member.accountId, '887600001');
  await grantConsent(member.accountId, 'service_channel', 'event', eventId);
  const campaignId = await createApprovedCampaign(owner, eventId, 'Not yours');
  const sent = await sendCampaign(owner, campaignId);
  assert.equal(sent.queued, 1);
  assert.equal(await campaignState(campaignId), 'running');

  // The member is a recipient of this very campaign and still has no say in it.
  const res = await cancel(member, campaignId);
  assertStatus(res, 404);
  assert.equal(((await res.json()) as { code: string }).code, 'not_found', 'a signed-in non-organizer gets the same answer as a stranger');
  assert.equal(await campaignState(campaignId), 'running');
  assert.equal((await jobIdStatuses(campaignId)).join(','), 'pending', 'the recipient cannot suppress their own message');
});

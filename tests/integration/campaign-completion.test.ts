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
import { GET as statsRoute } from '../../src/app/api/organizer/campaigns/[id]/stats/route';
import { getSql, closeSql } from '../../src/lib/db';
import { tickOnce } from '../../src/infra/worker';
import { MockTelegramTransport } from '../../src/integrations/telegram/mock-transport';
import { campaignIsDrained, NON_TERMINAL_CAMPAIGN_JOB_STATUSES } from '../../src/domain/campaigns';
import { OUTBOX_STATUSES } from '../../src/infra/outbox';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';
import { bindTelegram, grantConsent, withdrawConsent, drainWorker, jobRow } from './phase3-helpers';

after(async () => {
  await closeSql();
});

const sql = getSql();

/**
 * `campaigns.state = 'completed'` is REACHABLE, and reached at the honest moment.
 *
 * THE DEFECT THIS SUITE PINS. `completed` was declared in four places — the
 * `CampaignState` union, the `campaigns_state_check` constraint, the organizer
 * UI's immutable-state guard, and the state machine's own doc comment
 * (`draft → approved → running → completed | cancelled`) — and written by no code
 * path at all. So `running` was not a stage a campaign passed through but the
 * place it stopped: the worker finished every recipient, the counters went to
 * zero, and the row sat at `running` forever, uneditable (the edit route treats
 * running/completed/cancelled as immutable) and unsendable (`canSend` requires
 * `approved`). The declared terminal state was unreachable, which is the same
 * defect as a state machine that lies about itself.
 *
 * The three tests below take the three shapes of "all recipients are done" and
 * assert the transition, each from the angle that could separately be wrong:
 *
 *   1. the ordinary drain — sent and suppressed recipients, one after another,
 *      with an assertion that the campaign is NOT completed while a job is still
 *      queued, so the transition cannot pass by firing at send time;
 *   2. the zero-recipient send — no jobs exist at all, the vacuous case;
 *   3. the terminal failure — a job given up on ('unknown' at the attempt cap)
 *      completes the campaign without a single success.
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
      body: { display_name: `Completion ${prefix}`, languages: ['en'], offer_tags: [], need_tags: [] },
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
      body: { name: 'Completion Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC' },
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
    const membershipId = (
      await sql<{ id: string }[]>`SELECT id FROM event_memberships WHERE event_id = ${eventId} AND profile_id = ${member.profileId}`
    )[0]!.id;
    await sql`UPDATE event_memberships SET directory_visible = true WHERE id = ${membershipId}`;
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

async function stats(owner: Actor, campaignId: string) {
  const res = await statsRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/stats`, { cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(res, 200);
  return (await res.json()) as {
    state: string;
    drained: boolean;
    counters: Record<string, number>;
  };
}

async function campaignState(campaignId: string): Promise<string> {
  const rows = await sql<{ state: string }[]>`SELECT state FROM campaigns WHERE id = ${campaignId}`;
  return rows[0]!.state;
}

test('completion: the last recipient finalizes the campaign, not the send', async () => {
  const owner = await login('complete-owner');
  const a = await login('complete-a');
  const b = await login('complete-b');
  const eventId = await createEvent(owner);
  await addMember(eventId, a, { visible: true });
  await addMember(eventId, b, { visible: true });
  // service_channel does not require directory_visible, but consent still does.
  await bindTelegram(a.accountId, '889000001');
  // b has consent and NO channel: their job is suppressed 'no_channel'.
  for (const u of [a, b]) {
    await grantConsent(u.accountId, 'service_channel', 'event', eventId);
  }

  const campaignId = await createApprovedCampaign(owner, eventId, 'Completion check-in');

  const sent = await sendCampaign(owner, campaignId);
  assert.equal(sent.queued, 2, 'both consented members are queued');

  // THE ASSERTION THAT KEEPS THE TRANSITION HONEST: at send time the campaign
  // runs, because work is outstanding. A `completed` written by the send route
  // (rather than by the drain) would pass every later assertion in this test.
  assert.equal(sent.state, 'running', 'a send with queued recipients must report running');
  assert.equal(await campaignState(campaignId), 'running');

  const beforeDrain = await stats(owner, campaignId);
  assert.equal(beforeDrain.state, 'running');
  assert.equal(beforeDrain.drained, false, 'two recipients are still outstanding');
  assert.equal(beforeDrain.counters['pending'], 2);

  // ONE tick with a transport that cannot reach b: a is sent, b suppressed.
  // After this tick EVERY recipient is terminal — so the campaign must be done.
  await drainWorker(new MockTelegramTransport());

  const aJob = (
    await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`campaign:${campaignId}:${a.accountId}`}`
  )[0]!.id;
  const bJob = (
    await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`campaign:${campaignId}:${b.accountId}`}`
  )[0]!.id;
  assert.equal((await jobRow(aJob)).status, 'sent');
  assert.equal((await jobRow(bJob)).status, 'suppressed');

  const after = await stats(owner, campaignId);
  assert.equal(after.counters['pending'], 0);
  assert.equal(after.counters['leased'], 0);
  assert.equal(after.drained, true);
  assert.equal(after.state, 'completed', 'every recipient reached a terminal outcome');
  assert.equal(await campaignState(campaignId), 'completed', 'and the row says so, not just the endpoint');

  // The transition is idempotent: another tick must not touch it, and a
  // completed campaign stays completed.
  await tickOnce({ transport: new MockTelegramTransport() });
  assert.equal(await campaignState(campaignId), 'completed');
});

test('completion: a send that queues nobody is complete, not running forever', async () => {
  const owner = await login('complete-empty-owner');
  const member = await login('complete-empty-member');
  const eventId = await createEvent(owner);
  await addMember(eventId, member, { visible: true });
  // The member consents, is snapshotted at approve — and then withdraws BEFORE
  // the send. This is the AC-41 live revalidation path: the snapshot is frozen,
  // the send re-checks, and nobody is eligible. `queued` is 0.
  await grantConsent(member.accountId, 'service_channel', 'event', eventId);
  const campaignId = await createApprovedCampaign(owner, eventId, 'Nobody will receive this');
  const snapshotRows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM campaign_audience WHERE campaign_id = ${campaignId}
  `;
  assert.equal(snapshotRows[0]!.count, 1, 'the snapshot froze the member at approve time');
  // Appended, not mutated: consent_events is append-only and the resolver reads
  // the LATEST record, which is what the real withdrawal path does.
  await withdrawConsent(member.accountId, 'service_channel', 'event', eventId);

  const sent = await sendCampaign(owner, campaignId);
  assert.equal(sent.queued, 0, 'live revalidation excluded the only member');
  // The vacuous case: zero recipients. Every one of them has reached a terminal
  // outcome, so the campaign is finished the moment it starts. Reporting
  // 'running' here is the old behaviour and the reason the state was unreachable
  // for this shape of campaign.
  assert.equal(sent.state, 'completed', 'a campaign with no recipients is complete');

  const jobs = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs WHERE payload->>'campaign_id' = ${campaignId}
  `;
  assert.equal(jobs[0]!.count, 0, 'no job was enqueued');

  const after = await stats(owner, campaignId);
  assert.equal(after.state, 'completed');
  assert.equal(after.drained, true);
  // And it is genuinely terminal — the edit path refuses to reopen it, which is
  // the property that makes leaving it 'running' a dead end rather than a pause.
  assert.equal(await campaignState(campaignId), 'completed');
});

test('completion: a recipient given up on is terminal, so a campaign can complete without a success', async () => {
  const owner = await login('complete-unknown-owner');
  const member = await login('complete-unknown-member');
  const eventId = await createEvent(owner);
  await addMember(eventId, member, { visible: true });
  await bindTelegram(member.accountId, '889000777');
  await grantConsent(member.accountId, 'service_channel', 'event', eventId);

  const campaignId = await createApprovedCampaign(owner, eventId, 'This one will time out');
  const sent = await sendCampaign(owner, campaignId);
  assert.equal(sent.queued, 1);
  assert.equal(await campaignState(campaignId), 'running');

  const jobId = (
    await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`campaign:${campaignId}:${member.accountId}`}`
  )[0]!.id;

  // Three ticks against a transport that always times out: attempt 1 and 2
  // requeue with backoff, attempt 3 hits MAX_UNKNOWN_ATTEMPTS and goes terminal
  // 'unknown' (AC-42 "never infinite resend"). The real mock transport is used
  // with a scripted outcome rather than a hand-rolled stub, so this exercises the
  // same outcome-mapping the telegram transport produces for a timeout.
  const hanging = new MockTelegramTransport([
    { state: 'unknown', code: 'timeout' },
    { state: 'unknown', code: 'timeout' },
    { state: 'unknown', code: 'timeout' },
  ]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Backoff pushes due_at into the future; claiming is due-gated, so the next
    // tick would claim nothing without this. Draining sooner than the backoff
    // allows is the point: the test is about the cap, not about the delay.
    await sql`UPDATE outbox_jobs SET due_at = now() WHERE id = ${jobId}`;
    await tickOnce({ transport: hanging });
  }
  assert.equal(hanging.sendCount, 3, 'three attempts, then the cap');
  assert.equal((await jobRow(jobId)).status, 'unknown', 'given up on, not retried forever');

  const after = await stats(owner, campaignId);
  assert.equal(after.counters['sent'], 0, 'nothing was delivered');
  assert.equal(after.drained, true);
  assert.equal(after.state, 'completed', 'a terminal failure finishes the campaign too');
  assert.equal(await campaignState(campaignId), 'completed');
});

test('completion: the pure predicate and the SQL transition agree on what "terminal" means', () => {
  // The list drives the SQL (`status = ANY(NON_TERMINAL...)`) AND the reported
  // `drained` flag. If the two ever disagreed, `stats` would report a campaign as
  // drained while the transition declined to complete it — or the reverse.
  for (const status of OUTBOX_STATUSES) {
    const counters = { [status]: 1 };
    const expectedTerminal = !(NON_TERMINAL_CAMPAIGN_JOB_STATUSES as readonly string[]).includes(status);
    assert.equal(campaignIsDrained(counters), expectedTerminal, `status ${status} must be ${expectedTerminal ? 'terminal' : 'non-terminal'}`);
  }
  assert.equal(campaignIsDrained({}), true, 'no jobs at all is drained');
  assert.equal(campaignIsDrained({ sent: 5, suppressed: 2, pending: 1 }), false);
  assert.equal(campaignIsDrained({ sent: 5, suppressed: 2, leased: 1 }), false);
  assert.equal(campaignIsDrained({ sent: 5, suppressed: 2 }), true);
});

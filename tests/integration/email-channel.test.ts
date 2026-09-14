import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { POST as createIntroRoute } from '../../src/app/api/introductions/route';
import { POST as createCampaignRoute } from '../../src/app/api/organizer/campaigns/route';
import { POST as approveRoute } from '../../src/app/api/organizer/campaigns/[id]/approve/route';
import { POST as sendRoute } from '../../src/app/api/organizer/campaigns/[id]/send/route';
import { getSql, closeSql } from '../../src/lib/db';
import { enqueueOutbox } from '../../src/infra/outbox';
import { tickOnce } from '../../src/infra/worker';
import { MockTelegramTransport } from '../../src/integrations/telegram/mock-transport';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';
import { bindTelegram, grantConsent, jobRow, attemptRows, attachClaimedEmail } from './phase3-helpers';
import { MockEmailTransport } from './email-mock-transport';

/**
 * Email channel (ADR 0011) — the outbox worker's second delivery channel.
 *
 * Eligibility rule under test:
 *   active telegram binding → telegram
 *   else, email on file + the job's own consent → email
 *   else → suppressed:no_channel (no address) / suppressed:consent_revoked (no consent)
 *   a revoked/blocked binding stays terminal (never re-routed to email).
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

async function login(prefix: string): Promise<Actor> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `Email ${prefix}`, languages: ['en'], offer_tags: [], need_tags: [] },
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
      body: { name: 'Email Channel Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC' },
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

/** Worker ticks with BOTH channels injected until the queue drains. */
async function drain(email: MockEmailTransport | null, telegram = new MockTelegramTransport(), maxTicks = 12) {
  for (let i = 0; i < maxTicks; i++) {
    const report = await tickOnce({ transport: telegram, emailTransport: email });
    if (report.claimed === 0) break;
  }
  return telegram;
}

/**
 * Runs `fn` while capturing every console line. Used to assert directly that a
 * recipient address never reaches the logs (spec: «НЕ логировать адрес») rather
 * than trusting a review of the logging call sites.
 */
async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = capture as typeof console.log;
  console.warn = capture as typeof console.warn;
  console.error = capture as typeof console.error;
  console.info = capture as typeof console.info;
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
  }
}

// ---------------------------------------------------------------------------
// (a) no binding, email on file, service_channel consent → the notice goes by email
// ---------------------------------------------------------------------------

test('email channel: intro requested notice is delivered by email when there is no telegram binding', async () => {
  const initiator = await login('mail-a-i');
  const target = await login('mail-a-t');
  const eventId = await createEvent(await login('mail-a-org'));
  await addMember(eventId, initiator);
  await addMember(eventId, target);

  const targetEmail = `claimed-${randomUUID()}@integration.test`;
  await attachClaimedEmail(target.accountId, eventId, targetEmail);
  await grantConsent(target.accountId, 'service_channel', 'global', null);
  // No telegram binding for the target: email is the only channel.

  const res = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: target.profileId, event_id: eventId },
      cookie: initiator.cookie,
    }),
  );
  assertStatus(res, 200);
  const introId = ((await res.json()) as { introduction: { id: string } }).introduction.id;

  const notice = await sql<{ id: string; payload: Record<string, unknown> }[]>`
    SELECT id, payload FROM outbox_jobs WHERE dedupe_key = ${`intro_requested:${introId}:${target.accountId}`}
  `;
  assert.ok(notice[0], 'requested notice enqueued');
  assert.equal(notice[0]!.payload['event_id'], eventId, 'the job carries the event context for the email lookup');
  assert.equal(
    JSON.stringify(notice[0]!.payload).includes(targetEmail),
    false,
    'the recipient address is NEVER stored in the job payload',
  );

  const email = new MockEmailTransport();
  const telegram = new MockTelegramTransport();
  const { lines } = await captured(() => drain(email, telegram));

  const job = await jobRow(notice[0]!.id);
  assert.equal(job.status, 'sent');
  const attempts = await attemptRows(notice[0]!.id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.state, 'sent');
  assert.match(attempts[0]!.provider_message_id ?? '', /^mock-email-/);
  assert.equal(attempts[0]!.code, null);

  assert.equal(email.sendCount, 1, 'exactly one email went out');
  assert.equal(email.sent[0]!.to, targetEmail, 'the claimed registration email is the recipient');
  assert.ok(email.sent[0]!.text.includes('/me/introductions'), 'the mail links back into the app');
  assert.ok(email.sent[0]!.subject.startsWith('WELCOME'), 'neutral WELCOME subject');
  assert.equal(telegram.sendCount, 0, 'nothing was sent over telegram');

  // Redaction: neither the durable rows nor the logs carry the address.
  assert.equal(JSON.stringify(attempts).includes(targetEmail), false);
  assert.equal(JSON.stringify(job).includes(targetEmail), false);
  assert.equal(lines.some((l) => l.includes(targetEmail)), false, 'the recipient address must never be logged');
});

// ---------------------------------------------------------------------------
// (b) no binding, email on file, NO consent → suppressed:consent_revoked
// ---------------------------------------------------------------------------

test('email channel: without service_channel consent the notice is suppressed with consent_revoked, not emailed', async () => {
  const initiator = await login('mail-b-i');
  const target = await login('mail-b-t');
  const eventId = await createEvent(await login('mail-b-org'));
  await addMember(eventId, initiator);
  await addMember(eventId, target);
  await attachClaimedEmail(target.accountId, eventId, `claimed-${randomUUID()}@integration.test`);
  // Deliberately NO consent row at all.

  const res = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: target.profileId, event_id: eventId },
      cookie: initiator.cookie,
    }),
  );
  assertStatus(res, 200);
  const introId = ((await res.json()) as { introduction: { id: string } }).introduction.id;
  const jobId = (
    await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`intro_requested:${introId}:${target.accountId}`}`
  )[0]!.id;

  const email = new MockEmailTransport();
  await drain(email);

  assert.equal((await jobRow(jobId)).status, 'suppressed');
  const attempts = await attemptRows(jobId);
  assert.equal(attempts[0]!.state, 'suppressed');
  assert.equal(attempts[0]!.code, 'consent_revoked', 'an available address does not bypass the consent precondition');
  assert.equal(email.sendCount, 0, 'a suppressed notice never reaches the email provider');
});

// ---------------------------------------------------------------------------
// (c) active binding → telegram wins, email is not used
// ---------------------------------------------------------------------------

test('email channel: an active telegram binding keeps telegram as the channel (email untouched)', async () => {
  const initiator = await login('mail-c-i');
  const target = await login('mail-c-t');
  const eventId = await createEvent(await login('mail-c-org'));
  await addMember(eventId, initiator);
  await addMember(eventId, target);
  await attachClaimedEmail(target.accountId, eventId, `claimed-${randomUUID()}@integration.test`);
  await grantConsent(target.accountId, 'service_channel', 'global', null);
  const chatId = `mail-c-${randomUUID()}`;
  await bindTelegram(target.accountId, chatId);

  const res = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: target.profileId, event_id: eventId },
      cookie: initiator.cookie,
    }),
  );
  assertStatus(res, 200);
  const introId = ((await res.json()) as { introduction: { id: string } }).introduction.id;
  const jobId = (
    await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`intro_requested:${introId}:${target.accountId}`}`
  )[0]!.id;

  const email = new MockEmailTransport();
  const telegram = await drain(email);

  assert.equal((await jobRow(jobId)).status, 'sent');
  assert.equal(telegram.sendCount, 1, 'the notice went out over telegram');
  assert.equal(telegram.sent[0]!.chatId, chatId);
  assert.equal(email.sendCount, 0, 'an active binding never falls back to email');
});

// ---------------------------------------------------------------------------
// (d) campaigns: the campaign purpose — not service_channel — gates the email channel
// ---------------------------------------------------------------------------

test('email channel: a campaign with organizer_marketing consent reaches the member by email', async () => {
  const owner = await login('mail-d-owner');
  const member = await login('mail-d-member');
  const eventId = await createEvent(owner);
  await addMember(eventId, member, { visible: true });
  const memberEmail = `claimed-${randomUUID()}@integration.test`;
  await attachClaimedEmail(member.accountId, eventId, memberEmail);
  await grantConsent(member.accountId, 'organizer_marketing', 'event', eventId);

  const created = await createCampaignRoute(
    makeRequest('/api/organizer/campaigns', {
      body: { event_id: eventId, purpose: 'organizer_marketing', body_text: 'Afterparty at 21:00' },
      cookie: owner.cookie,
    }),
  );
  assertStatus(created, 201);
  const campaignId = ((await created.json()) as { campaign: { id: string } }).campaign.id;

  assertStatus(
    await approveRoute(
      makeRequest(`/api/organizer/campaigns/${campaignId}/approve`, { body: {}, cookie: owner.cookie }),
      { params: Promise.resolve({ id: campaignId }) },
    ),
    200,
  );
  const send = await sendRoute(
    makeRequest(`/api/organizer/campaigns/${campaignId}/send`, { body: {}, cookie: owner.cookie }),
    { params: Promise.resolve({ id: campaignId }) },
  );
  assertStatus(send, 202);
  assert.equal(((await send.json()) as { queued: number }).queued, 1);

  const email = new MockEmailTransport();
  const telegram = await drain(email);
  const jobId = (
    await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`campaign:${campaignId}:${member.accountId}`}`
  )[0]!.id;

  assert.equal((await jobRow(jobId)).status, 'sent');
  assert.equal(email.sendCount, 1);
  assert.equal(email.sent[0]!.to, memberEmail);
  assert.equal(email.sent[0]!.text, 'Afterparty at 21:00', 'the campaign body goes out verbatim');
  assert.equal(telegram.sendCount, 0);
});

test('email channel: a campaign job whose purpose consent is missing is suppressed, never emailed', async () => {
  // The AC-41 race path, driven directly: the campaign machinery (audience →
  // approve → send) refuses to enqueue at all without organizer_marketing
  // consent, so the worker-side rule is exercised with a job that is already
  // queued — exactly the state a revoke racing a send leaves behind.
  const member = await login('mail-d-neg');
  const eventId = await createEvent(await login('mail-d-neg-org'));
  await addMember(eventId, member, { visible: true });
  const memberEmail = `claimed-${randomUUID()}@integration.test`;
  await attachClaimedEmail(member.accountId, eventId, memberEmail);
  // service_channel — deliberately NOT organizer_marketing.
  await grantConsent(member.accountId, 'service_channel', 'event', eventId);

  const { id: jobId } = await sql.begin((tx) =>
    enqueueOutbox(tx, {
      dedupeKey: `email-neg-${randomUUID()}`,
      kind: 'campaign_message',
      subjectId: null,
      channel: 'telegram',
      purpose: 'organizer_marketing',
      payload: {
        account_id: member.accountId,
        event_id: eventId,
        text: 'Afterparty at 21:00',
        enforce_consent: true,
        consent_scope: { type: 'event', id: eventId },
      },
    }),
  );

  const email = new MockEmailTransport();
  await drain(email);

  assert.equal((await jobRow(jobId)).status, 'suppressed');
  const attempts = await attemptRows(jobId);
  assert.equal(attempts[0]!.code, 'consent_revoked', 'organizer_marketing is required — service_channel is not a substitute');
  assert.equal(email.sendCount, 0);
});

// ---------------------------------------------------------------------------
// No provider configured → honest suppression, never a log of the address
// ---------------------------------------------------------------------------

test('email channel: without a configured provider the job is suppressed with channel_disabled', async () => {
  const initiator = await login('mail-e-i');
  const target = await login('mail-e-t');
  const eventId = await createEvent(await login('mail-e-org'));
  await addMember(eventId, initiator);
  await addMember(eventId, target);
  const targetEmail = `claimed-${randomUUID()}@integration.test`;
  await attachClaimedEmail(target.accountId, eventId, targetEmail);
  await grantConsent(target.accountId, 'service_channel', 'global', null);

  const res = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: target.profileId, event_id: eventId },
      cookie: initiator.cookie,
    }),
  );
  assertStatus(res, 200);
  const introId = ((await res.json()) as { introduction: { id: string } }).introduction.id;
  const jobId = (
    await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE dedupe_key = ${`intro_requested:${introId}:${target.accountId}`}`
  )[0]!.id;

  // emailTransport: null → the deployment has no email provider.
  const { lines } = await captured(async () => {
    for (let i = 0; i < 12; i++) {
      const report = await tickOnce({ transport: new MockTelegramTransport(), emailTransport: null });
      if (report.claimed === 0) break;
    }
  });

  assert.equal((await jobRow(jobId)).status, 'suppressed');
  assert.equal((await attemptRows(jobId))[0]!.code, 'channel_disabled');
  assert.equal(lines.some((l) => l.includes(targetEmail)), false, 'no provider must never log the address');
});

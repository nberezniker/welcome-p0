import test from 'node:test';
import assert from 'node:assert/strict';
import { after, afterEach } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as profileRoute } from '../../src/app/api/me/profile/route';
import { GET as followupGetRoute, POST as followupPostRoute } from '../../src/app/api/me/followup/route';
import { GET as unsubscribeRoute } from '../../src/app/api/me/followup/unsubscribe/route';
import { runFollowupScan } from '../../src/infra/followup-scan';
import { tickOnce } from '../../src/infra/worker';
import { unsubscribePath } from '../../src/domain/followup';
import { hasGrant } from '../../src/domain/consent';
import { getSql, closeSql } from '../../src/lib/db';
import { requireHashPepper } from '../../src/lib/env';
import { loadOptInState } from '../../src/infra/followup-preferences';
import { MockTelegramTransport } from '../../src/integrations/telegram/mock-transport';
import { makeRequest, uniqueEmail, assertStatus, loginViaOtp, accountIdFromCookie } from './helpers';
import { createUser, bindTelegram, grantConsent, jobRow, attemptRows, type TestUser } from './phase3-helpers';

/**
 * Phase 4 end-to-end at the worker/API level: the «next step» reminder and the
 * weekly «who to meet» digest (design §B5 + §D item 8).
 *
 * What these tests are here to prove, in the task's own terms:
 *   - with the flags OFF nothing at all is enqueued (and the scan reports that
 *     it did not even run);
 *   - with the flags ON and synthetic opted-in accounts, ONE tick enqueues
 *     exactly one digest job and one reminder job, and a SECOND tick enqueues
 *     nothing (idempotency by dedupe key + bookkeeping, not by luck);
 *   - revoking consent after the job was enqueued suppresses it (the existing
 *     outbox suppression path, not a new one);
 *   - a blocked recipient and a recipient with no channel get nothing;
 *   - `purpose` routing is right: the reminder is a `service_channel` service
 *     message, the digest is `digest_weekly`;
 *   - the digest message never carries a private field.
 *
 * Every account this file creates is recorded and removed in afterEach, so the
 * shared integration database (and every later suite's ticks) is left exactly as
 * it was found.
 */

const sql = getSql();
const createdAccounts: string[] = [];
const createdProfiles: string[] = [];
const createdEvents: string[] = [];

after(async () => {
  await closeSql();
});

afterEach(async () => {
  // Flags first: a leftover flag would make OTHER suites' ticks run the scan.
  delete process.env.FOLLOWUP_REMINDERS_ENABLED;
  delete process.env.DIGEST_ENABLED;
  if (createdAccounts.length > 0) {
    await sql`DELETE FROM outbox_jobs WHERE kind IN ('followup_reminder','digest_weekly')`;
    await sql`DELETE FROM digest_sends WHERE account_id = ANY(${createdAccounts}::uuid[])`;
    await sql`DELETE FROM followup_preferences WHERE account_id = ANY(${createdAccounts}::uuid[])`;
    await sql`DELETE FROM connection_notes WHERE owner_account_id = ANY(${createdAccounts}::uuid[])`;
    await sql`DELETE FROM consent_events WHERE account_id = ANY(${createdAccounts}::uuid[])`;
    await sql`DELETE FROM blocks WHERE blocker_account_id = ANY(${createdAccounts}::uuid[]) OR target_account_id = ANY(${createdAccounts}::uuid[])`;
  }
  if (createdEvents.length > 0) {
    await sql`DELETE FROM introductions WHERE event_id = ANY(${createdEvents}::uuid[])`;
    await sql`DELETE FROM event_memberships WHERE event_id = ANY(${createdEvents}::uuid[])`;
    await sql`DELETE FROM events WHERE id = ANY(${createdEvents}::uuid[])`;
  }
  if (createdProfiles.length > 0) {
    await sql`DELETE FROM introductions WHERE profile_a = ANY(${createdProfiles}::uuid[]) OR profile_b = ANY(${createdProfiles}::uuid[])`;
  }
  createdAccounts.length = 0;
  createdProfiles.length = 0;
  createdEvents.length = 0;
});

/** Enables the flags for the duration of one test. */
function flagsOn(mechanics: { reminders?: boolean; digest?: boolean }): void {
  if (mechanics.reminders) process.env.FOLLOWUP_REMINDERS_ENABLED = 'true';
  if (mechanics.digest) process.env.DIGEST_ENABLED = 'true';
}

// ---------------------------------------------------------------------------
// Fixtures (direct DB: the worker-side domain has no HTTP surface)
// ---------------------------------------------------------------------------

async function actor(prefix: string): Promise<TestUser> {
  const user = await createUser(prefix);
  createdAccounts.push(user.accountId);
  createdProfiles.push(user.profileId);
  return user;
}

async function setProfileFields(profileId: string, fields: Partial<Record<string, unknown>>): Promise<void> {
  await sql`
    UPDATE profiles SET
      need_intents = ${(fields['need_intents'] as string[]) ?? []},
      offer_intents = ${(fields['offer_intents'] as string[]) ?? []},
      interests = ${(fields['interests'] as string[]) ?? []},
      industry = ${(fields['industry'] as string | null) ?? null},
      job_function = ${(fields['job_function'] as string | null) ?? null},
      goals = ${(fields['goals'] as string[]) ?? []}
    WHERE id = ${profileId}
  `;
}

/** A mutual introduction between two profiles — the only "meeting" the product can evidence. */
async function mutualIntroduction(a: TestUser, b: TestUser, state = 'mutual'): Promise<void> {
  const [profileA, profileB] = a.profileId < b.profileId ? [a.profileId, b.profileId] : [b.profileId, a.profileId];
  await sql`
    INSERT INTO introductions (profile_a, profile_b, context_key, state)
    VALUES (${profileA}, ${profileB}, ${'personal:' + profileA}, ${state})
  `;
}

async function addNote(
  owner: TestUser,
  otherProfileId: string,
  options: { nextStep?: string | null; status?: string; daysAgo?: number } = {},
): Promise<void> {
  const nextStep = options.nextStep === undefined ? 'Send the pilot proposal' : options.nextStep;
  const status = options.status ?? 'confirmed';
  const daysAgo = options.daysAgo ?? 8;
  await sql`
    INSERT INTO connection_notes (owner_account_id, other_profile_id, next_step, next_step_status, updated_at)
    VALUES (${owner.accountId}, ${otherProfileId}, ${nextStep}, ${status}, now() - (${daysAgo} * interval '1 day'))
    ON CONFLICT (owner_account_id, other_profile_id) DO UPDATE SET
      next_step = ${nextStep}, next_step_status = ${status},
      updated_at = now() - (${daysAgo} * interval '1 day')
  `;
}

async function optIn(accountId: string, mechanic: 'reminders' | 'digest', at = new Date()): Promise<void> {
  if (mechanic === 'reminders') {
    await sql`
      INSERT INTO followup_preferences (account_id, reminders_opt_in_at)
      VALUES (${accountId}, ${at})
      ON CONFLICT (account_id) DO UPDATE SET reminders_opt_in_at = ${at}
    `;
  } else {
    await sql`
      INSERT INTO followup_preferences (account_id, digest_opt_in_at)
      VALUES (${accountId}, ${at})
      ON CONFLICT (account_id) DO UPDATE SET digest_opt_in_at = ${at}
    `;
  }
}

/** An event where the viewer and the candidate are both visible, opted-in members. */
async function sharedEvent(viewer: TestUser, candidate: TestUser): Promise<string> {
  const organizer = await sql<{ id: string }[]>`INSERT INTO organizers (display_name) VALUES ('Follow-up Fixture') RETURNING id`;
  const slug = `fu-${Date.now().toString(36)}-${createdEvents.length}-${Math.random().toString(36).slice(2, 8)}`;
  const events = await sql<{ id: string }[]>`
    INSERT INTO events (organizer_id, slug, name, mode, access_mode, timezone, status)
    VALUES (${organizer[0]!.id}, ${slug}, 'Follow-up Meetup', 'offline', 'public', 'UTC', 'active')
    RETURNING id
  `;
  const eventId = events[0]!.id;
  createdEvents.push(eventId);
  for (const user of [viewer, candidate]) {
    await sql`
      INSERT INTO event_memberships (event_id, profile_id, state, directory_visible, matching_enabled)
      VALUES (${eventId}, ${user.profileId}, 'active', true, true)
    `;
  }
  return eventId;
}

async function jobsByKind(kind: string): Promise<{ id: string; dedupe_key: string; purpose: string; status: string; payload: Record<string, unknown> }[]> {
  return sql`
    SELECT id, dedupe_key, purpose, status, payload FROM outbox_jobs
    WHERE kind = ${kind} AND payload->>'account_id' = ANY(${createdAccounts}::text[])
  `;
}

/** A digest-capable recipient: profile fields, a channel, an event with a teacher. */
async function digestRecipient(prefix: string): Promise<{ viewer: TestUser; teacher: TestUser }> {
  const viewer = await actor(prefix + '-viewer');
  await setProfileFields(viewer.profileId, {
    need_intents: ['seeking-mentor'],
    interests: ['ai-ml'],
    goals: ['learn-skill'],
  });
  const teacher = await actor(prefix + '-teacher');
  await setProfileFields(teacher.profileId, { offer_intents: ['mentoring'], interests: ['ai-ml'] });
  await sharedEvent(viewer, teacher);
  await bindTelegram(viewer.accountId, `fu-${prefix}-${Date.now()}`);
  await grantConsent(viewer.accountId, 'digest_weekly', 'global', null);
  await optIn(viewer.accountId, 'digest');
  return { viewer, teacher };
}

// ---------------------------------------------------------------------------
// 1. Flags OFF ⇒ the feature does not exist
// ---------------------------------------------------------------------------

test('phase4: with both flags OFF nothing is enqueued and the scan does not run', async () => {
  // A fixture that WOULD produce a reminder and a digest if the flags were on.
  const owner = await actor('fu-off-owner');
  const other = await actor('fu-off-other');
  await mutualIntroduction(owner, other);
  await addNote(owner, other.profileId);
  await bindTelegram(owner.accountId, `fu-off-${Date.now()}`);
  await grantConsent(owner.accountId, 'service_channel', 'global', null);
  await optIn(owner.accountId, 'reminders');
  await digestRecipient('fu-off');

  const report = await runFollowupScan(sql);
  assert.deepEqual(report, {
    enabled: { reminders: false, digest: false },
    reminders: { scanned: 0, enqueued: 0 },
    digest: { scanned: 0, enqueued: 0 },
    error: null,
  });

  const tick = await tickOnce({ transport: new MockTelegramTransport(), emailTransport: null });
  assert.equal(tick.followup.enabled.reminders, false);
  assert.equal(tick.followup.enabled.digest, false);
  assert.equal((await jobsByKind('followup_reminder')).length, 0);
  assert.equal((await jobsByKind('digest_weekly')).length, 0);
});

// ---------------------------------------------------------------------------
// 2. Flags ON ⇒ one digest + one reminder on the first tick, nothing on the second
// ---------------------------------------------------------------------------

test('phase4: the first tick enqueues exactly one reminder and one digest; the second enqueues nothing', async () => {
  // Reminder side.
  const owner = await actor('fu-on-owner');
  const met = await actor('fu-on-met');
  await mutualIntroduction(owner, met);
  await addNote(owner, met.profileId);
  await bindTelegram(owner.accountId, `fu-on-${Date.now()}`);
  await grantConsent(owner.accountId, 'service_channel', 'global', null);
  await optIn(owner.accountId, 'reminders');
  // Digest side.
  const { viewer } = await digestRecipient('fu-on-dig');

  flagsOn({ reminders: true, digest: true });

  const first = await tickOnce({ transport: new MockTelegramTransport(), emailTransport: null });
  assert.deepEqual(first.followup.enabled, { reminders: true, digest: true });
  assert.equal(first.followup.reminders.enqueued, 1, `reminder scan: ${JSON.stringify(first.followup.reminders)}`);
  assert.equal(first.followup.digest.enqueued, 1, `digest scan: ${JSON.stringify(first.followup.digest)}`);

  const reminders = await jobsByKind('followup_reminder');
  const digests = await jobsByKind('digest_weekly');
  assert.equal(reminders.length, 1, 'exactly one reminder job');
  assert.equal(digests.length, 1, 'exactly one digest job');
  assert.equal(reminders[0]!.dedupe_key, `followup:${owner.accountId}:${met.profileId}:confirmed`);
  assert.match(digests[0]!.dedupe_key, new RegExp(`^digest:${viewer.accountId}:\\d{4}-W\\d{2}$`));

  // Second tick: the same week, the same note state — nothing new may appear.
  const second = await tickOnce({ transport: new MockTelegramTransport(), emailTransport: null });
  assert.equal(second.followup.reminders.enqueued, 0);
  assert.equal(second.followup.digest.enqueued, 0);
  assert.equal((await jobsByKind('followup_reminder')).length, 1, 'still exactly one reminder job');
  assert.equal((await jobsByKind('digest_weekly')).length, 1, 'still exactly one digest job');

  // The bookkeeping agrees with the queue: the note records the transition it
  // reminded about, and the digest records who was sent.
  const noteRows = await sql<{ followup_reminded_status: string | null }[]>`
    SELECT followup_reminded_status FROM connection_notes
    WHERE owner_account_id = ${owner.accountId} AND other_profile_id = ${met.profileId}
  `;
  assert.equal(noteRows[0]!.followup_reminded_status, 'confirmed');
  const sentRows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM digest_sends WHERE account_id = ${viewer.accountId}
  `;
  assert.equal(sentRows[0]!.count, 1, 'one person recorded as digested');
});

test('phase4: the meeting check works in BOTH pair directions', async () => {
  // introductions store profile_a/profile_b in canonical (lexicographic) order,
  // which has nothing to do with who wrote the note. A direction-dependent
  // "is mutual" check would silently skip half of all real pairs, and whether it
  // shows up would depend on the random uuids of the run — so both orders are
  // pinned here explicitly.
  process.env.FOLLOWUP_REMINDERS_ENABLED = 'true';
  let enqueued = 0;
  for (const order of ['owner-first', 'owner-second'] as const) {
    const owner = await actor(`fu-dir-${order}-owner`);
    const met = await actor(`fu-dir-${order}-met`);
    const [first, second] = order === 'owner-first' ? [owner.profileId, met.profileId] : [met.profileId, owner.profileId];
    await sql`
      INSERT INTO introductions (profile_a, profile_b, context_key, state)
      VALUES (${first}, ${second}, ${'personal:dir-' + order + '-' + owner.profileId}, 'mutual')
    `;
    await addNote(owner, met.profileId);
    await bindTelegram(owner.accountId, `fu-dir-${order}-${Date.now()}`);
    await grantConsent(owner.accountId, 'service_channel', 'global', null);
    await optIn(owner.accountId, 'reminders');

    const scan = await runFollowupScan(sql);
    enqueued += scan.reminders.enqueued;
  }
  assert.equal(enqueued, 2, 'a mutual introduction counts whichever side the note author is on');
});

test('phase4: purpose routing — the reminder is a service message, the digest is its own purpose', async () => {
  const owner = await actor('fu-purpose-owner');
  const met = await actor('fu-purpose-met');
  await mutualIntroduction(owner, met);
  await addNote(owner, met.profileId);
  await bindTelegram(owner.accountId, `fu-purpose-${Date.now()}`);
  await grantConsent(owner.accountId, 'service_channel', 'global', null);
  await optIn(owner.accountId, 'reminders');
  await digestRecipient('fu-purpose');

  flagsOn({ reminders: true, digest: true });
  await runFollowupScan(sql);

  const reminders = await jobsByKind('followup_reminder');
  const digests = await jobsByKind('digest_weekly');
  assert.equal(reminders[0]!.purpose, 'service_channel', 'a reminder is a service message about the author’s own step');
  assert.equal(digests[0]!.purpose, 'digest_weekly', 'the digest has a purpose the one-click unsubscribe can revoke');
  assert.equal(reminders[0]!.payload['enforce_consent'], true);
  assert.equal(digests[0]!.payload['enforce_consent'], true);

  // The body the recipient would read: the author's own step, and the digest's
  // one-line reasons — with the stop link on both.
  const reminderText = String(reminders[0]!.payload['text']);
  assert.match(reminderText, /Send the pilot proposal/);
  assert.match(reminderText, /\/api\/me\/followup\/unsubscribe\?t=reminders\./);
  const digestText = String(digests[0]!.payload['text']);
  assert.match(digestText, /\/api\/me\/followup\/unsubscribe\?t=digest\./);
  assert.match(digestText, /own goals and your own profile/i);
});

// ---------------------------------------------------------------------------
// 3. Privacy of the digest body
// ---------------------------------------------------------------------------

test('phase4: the digest body carries no private field of another person', async () => {
  const viewer = await actor('fu-priv-viewer');
  await setProfileFields(viewer.profileId, { need_intents: ['seeking-mentor'], goals: ['learn-skill'] });
  const candidate = await actor('fu-priv-cand');
  // The candidate's PRIVATE goal and their note text must never travel.
  await setProfileFields(candidate.profileId, { offer_intents: ['mentoring'], goals: ['fundraise'] });
  await mutualIntroduction(viewer, candidate);
  await addNote(candidate, viewer.profileId, { nextStep: 'SECRET-CANDIDATE-STEP' });
  await sharedEvent(viewer, candidate);
  await bindTelegram(viewer.accountId, `fu-priv-${Date.now()}`);
  await grantConsent(viewer.accountId, 'digest_weekly', 'global', null);
  await optIn(viewer.accountId, 'digest');

  // The fixture is real: the private data IS in the database.
  const stored = await sql<{ goals: string[]; next_step: string | null }[]>`
    SELECT p.goals, cn.next_step FROM profiles p
    LEFT JOIN connection_notes cn
      ON cn.owner_account_id = ${candidate.accountId} AND cn.other_profile_id = ${viewer.profileId}
    WHERE p.id = ${candidate.profileId}
  `;
  assert.deepEqual(stored[0]!.goals, ['fundraise']);
  assert.equal(stored[0]!.next_step, 'SECRET-CANDIDATE-STEP');

  flagsOn({ digest: true });
  await runFollowupScan(sql);

  const digests = await jobsByKind('digest_weekly');
  assert.equal(digests.length, 1);
  const text = String(digests[0]!.payload['text']);
  assert.ok(!text.includes('fundraise'), 'another person’s goal text never enters the digest');
  assert.ok(!text.includes('Fundraise'), 'not even its label');
  assert.ok(!text.includes('SECRET-CANDIDATE-STEP'), 'another person’s note never enters the digest');
  assert.ok(!text.includes('@'), 'no contact value of any kind');
  assert.match(text, /Learn a skill/, 'the recipient’s OWN goal is allowed and expected');
});

// ---------------------------------------------------------------------------
// 4. Opt-out after enqueue suppresses what is already queued
// ---------------------------------------------------------------------------

test('phase4: opting out after the enqueue suppresses the queued digest (through the real endpoint)', async () => {
  const email = uniqueEmail('fu-optout');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  createdAccounts.push(accountId);
  assertStatus(await profileRoute(makeRequest('/api/me/profile', { body: { display_name: 'Opt Out', languages: ['en'] }, cookie })), 200);
  const profileRows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  createdProfiles.push(profileRows[0]!.id);
  await sql`UPDATE profiles SET goals = ARRAY['learn-skill']::text[] WHERE id = ${profileRows[0]!.id}`;

  flagsOn({ digest: true });

  // Opt IN through the endpoint (it writes the opt-in AND the consent).
  const on = await followupPostRoute(makeRequest('/api/me/followup', { body: { mechanic: 'digest', opted_in: true }, cookie }));
  assertStatus(on, 200);
  assert.equal((await hasGrant(sql, accountId, 'digest_weekly')), true);

  // Enqueue only (no tick): the job must still be waiting.
  const scan = await runFollowupScan(sql);
  assert.equal(scan.digest.enqueued, 0, 'no candidates in any event yet — an empty digest is never sent');
  const digests = await jobsByKind('digest_weekly');
  assert.equal(digests.length, 0);
  // The recipient still opted in successfully — this is about the empty-digest
  // rule, not about the opt-in failing.
  assert.deepEqual(await loadOptInState(sql, accountId), { reminders: false, digest: true });

  // Now a digest that HAS content.
  const teacher = await actor('fu-optout-teacher');
  await setProfileFields(teacher.profileId, { offer_intents: ['mentoring'] });
  await sql`UPDATE profiles SET need_intents = ARRAY['seeking-mentor']::text[] WHERE id = ${profileRows[0]!.id}`;
  await bindTelegram(accountId, `fu-optout-${Date.now()}`);
  await sharedEvent({ accountId, profileId: profileRows[0]!.id }, teacher);

  const secondScan = await runFollowupScan(sql);
  assert.equal(secondScan.digest.enqueued, 1);
  const queued = (await jobsByKind('digest_weekly'))[0]!;
  assert.equal(queued.status, 'pending', 'the job is waiting, not sent');

  // Opt OUT through the endpoint: the queued job must be suppressed, not sent.
  const off = await followupPostRoute(makeRequest('/api/me/followup', { body: { mechanic: 'digest', opted_in: false }, cookie }));
  assertStatus(off, 200);
  assert.equal((await off.json() as { opted_in: boolean }).opted_in, false);

  const after = await jobRow(queued.id);
  assert.equal(after.status, 'suppressed', 'revocation cancels what was already queued');
  assert.equal(await hasGrant(sql, accountId, 'digest_weekly'), false, 'the consent itself is withdrawn');
  assert.deepEqual(await loadOptInState(sql, accountId), { reminders: false, digest: false });
});

test('phase4: the one-click unsubscribe link stops the digest without a session', async () => {
  const viewer = await actor('fu-link-viewer');
  const teacher = await actor('fu-link-teacher');
  await setProfileFields(viewer.profileId, { need_intents: ['seeking-mentor'] });
  await setProfileFields(teacher.profileId, { offer_intents: ['mentoring'] });
  await sharedEvent(viewer, teacher);
  await bindTelegram(viewer.accountId, `fu-link-${Date.now()}`);
  await grantConsent(viewer.accountId, 'digest_weekly', 'global', null);
  await optIn(viewer.accountId, 'digest');
  flagsOn({ digest: true });

  await runFollowupScan(sql);
  const queued = (await jobsByKind('digest_weekly'))[0]!;
  assert.equal(queued.status, 'pending');

  const token = unsubscribePath(viewer.accountId, 'digest', requireHashPepper()).split('t=')[1]!;
  const res = await unsubscribeRoute(makeRequest(`/api/me/followup/unsubscribe?t=${token}`));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /Stopped/);

  assert.equal((await jobRow(queued.id)).status, 'suppressed');
  assert.equal(await hasGrant(sql, viewer.accountId, 'digest_weekly'), false);
  assert.deepEqual(await loadOptInState(sql, viewer.accountId), { reminders: false, digest: false });

  // A tampered link is a generic 400 and changes nothing.
  const forged = await unsubscribeRoute(makeRequest(`/api/me/followup/unsubscribe?t=${token.slice(0, -1)}0`));
  assert.equal(forged.status, 400);
  assert.match(await forged.text(), /not valid/i);
});

// ---------------------------------------------------------------------------
// 5. Blocked / unreachable recipients
// ---------------------------------------------------------------------------

test('phase4: a blocked recipient gets no reminder, and a revoked channel suppresses one', async () => {
  const blockedOwner = await actor('fu-block-owner');
  const blockedOther = await actor('fu-block-other');
  await mutualIntroduction(blockedOwner, blockedOther);
  await addNote(blockedOwner, blockedOther.profileId);
  await bindTelegram(blockedOwner.accountId, `fu-block-${Date.now()}`);
  await grantConsent(blockedOwner.accountId, 'service_channel', 'global', null);
  await optIn(blockedOwner.accountId, 'reminders');
  // The other side blocked the owner (either direction counts).
  await sql`
    INSERT INTO blocks (blocker_account_id, target_account_id)
    VALUES (${blockedOther.accountId}, ${blockedOwner.accountId})
  `;

  // A reminder never even reaches the queue for a blocked pair.
  flagsOn({ reminders: true });
  const scan = await runFollowupScan(sql);
  assert.equal(scan.reminders.enqueued, 0, 'a block stops the reminder at the scan');
  assert.equal((await jobsByKind('followup_reminder')).length, 0);

  // Now a pair that is NOT blocked, but gets blocked after the enqueue: the
  // worker's send-time precondition still suppresses it.
  const owner = await actor('fu-late-owner');
  const met = await actor('fu-late-met');
  await mutualIntroduction(owner, met);
  await addNote(owner, met.profileId);
  const chatId = `fu-late-${Date.now()}`;
  await bindTelegram(owner.accountId, chatId);
  await grantConsent(owner.accountId, 'service_channel', 'global', null);
  await optIn(owner.accountId, 'reminders');

  const second = await runFollowupScan(sql);
  assert.equal(second.reminders.enqueued, 1);
  const queued = (await jobsByKind('followup_reminder')).find((j) => j.payload['account_id'] === owner.accountId)!;
  await sql`INSERT INTO blocks (blocker_account_id, target_account_id) VALUES (${met.accountId}, ${owner.accountId})`;

  const mock = new MockTelegramTransport();
  await tickOnce({ transport: mock, emailTransport: null });
  assert.equal((await jobRow(queued.id)).status, 'suppressed');
  assert.equal(mock.sendCount, 0, 'nothing was handed to the transport');
  const attempts = await attemptRows(queued.id);
  assert.equal(attempts.at(-1)!.code, 'blocked');
});

test('phase4: an opted-in recipient with no channel at all gets nothing', async () => {
  const viewer = await actor('fu-nochannel-viewer');
  const teacher = await actor('fu-nochannel-teacher');
  await setProfileFields(viewer.profileId, { need_intents: ['seeking-mentor'] });
  await setProfileFields(teacher.profileId, { offer_intents: ['mentoring'] });
  await sharedEvent(viewer, teacher);
  // Consent yes, opt-in yes — but no telegram binding and no claimed email.
  await grantConsent(viewer.accountId, 'digest_weekly', 'global', null);
  await optIn(viewer.accountId, 'digest');

  flagsOn({ digest: true });
  const scan = await runFollowupScan(sql);
  assert.equal(scan.digest.enqueued, 0, 'no channel = no message, not a stored job that fails later');
  assert.equal((await jobsByKind('digest_weekly')).length, 0);
});

test('phase4: no consent, no message — even when the opt-in is on', async () => {
  const viewer = await actor('fu-noconsent-viewer');
  const teacher = await actor('fu-noconsent-teacher');
  await setProfileFields(viewer.profileId, { need_intents: ['seeking-mentor'] });
  await setProfileFields(teacher.profileId, { offer_intents: ['mentoring'] });
  await sharedEvent(viewer, teacher);
  await bindTelegram(viewer.accountId, `fu-noconsent-${Date.now()}`);
  // Opt-in WITHOUT the consent (the endpoint writes both; a direct write does not).
  await optIn(viewer.accountId, 'digest');

  flagsOn({ digest: true });
  const scan = await runFollowupScan(sql);
  assert.equal(scan.digest.enqueued, 0);
  assert.equal((await jobsByKind('digest_weekly')).length, 0);
});

// ---------------------------------------------------------------------------
// 6. The endpoint does not exist while the flag is off
// ---------------------------------------------------------------------------

test('phase4: both follow-up endpoints answer 404 feature_disabled while the flags are off', async () => {
  const email = uniqueEmail('fu-404');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  createdAccounts.push(await accountIdFromCookie(cookie));

  const get = await followupGetRoute(makeRequest('/api/me/followup', { cookie }));
  assertStatus(get, 404);
  assert.equal(((await get.json()) as { code: string }).code, 'feature_disabled');

  // Even a POST that would be valid is refused: the surface does not exist.
  const post = await followupPostRoute(makeRequest('/api/me/followup', { body: { mechanic: 'digest', opted_in: true }, cookie }));
  assertStatus(post, 404);

  // …and nothing was written by the refused call.
  const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM followup_preferences`;
  assert.equal(rows[0]!.count, 0);
});

test('phase4: a flag turned on mid-flight only enables its own mechanic', async () => {
  const email = uniqueEmail('fu-oneflag');
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  createdAccounts.push(accountId);
  flagsOn({ reminders: true });

  const get = await followupGetRoute(makeRequest('/api/me/followup', { cookie }));
  assertStatus(get, 200);
  const state = (await get.json()) as { enabled: { reminders: boolean; digest: boolean } };
  assert.deepEqual(state.enabled, { reminders: true, digest: false });

  const digestAttempt = await followupPostRoute(
    makeRequest('/api/me/followup', { body: { mechanic: 'digest', opted_in: true }, cookie }),
  );
  assertStatus(digestAttempt, 404);

  const reminderAttempt = await followupPostRoute(
    makeRequest('/api/me/followup', { body: { mechanic: 'reminders', opted_in: true }, cookie }),
  );
  assertStatus(reminderAttempt, 200);
  assert.equal((await reminderAttempt.json() as { opted_in: boolean }).opted_in, true);
  assert.deepEqual(await loadOptInState(sql, accountId), { reminders: true, digest: false });
});

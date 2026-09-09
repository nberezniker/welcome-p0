import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as webhookRoute } from '../../src/app/api/webhooks/telegram/route';
import { POST as challengeRoute } from '../../src/app/api/channels/telegram/challenge/route';
import { POST as confirmRoute } from '../../src/app/api/channels/telegram/confirm/route';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { getSql, closeSql } from '../../src/lib/db';
import { MockTelegramTransport } from '../../src/integrations/telegram/mock-transport';
import { tickOnce } from '../../src/infra/worker';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';
import { createUser, bindTelegram, jobRow, attemptRows, drainWorker } from './phase3-helpers';

after(async () => {
  await closeSql();
});

const sql = getSql();
const WEBHOOK_HEADER = 'integration-telegram-webhook-secret';

/** Sends a Telegram message update through the real webhook route with an explicit update_id. */
function sendUpdate(chatId: number, text: string, updateId: number): Promise<Response> {
  return webhookRoute(
    makeRequest('/api/webhooks/telegram', {
      body: {
        update_id: updateId,
        message: { message_id: updateId, from: { id: chatId }, chat: { id: chatId }, text },
      },
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_HEADER },
    }),
  );
}

async function accountConsentCount(accountId: string): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM consent_events WHERE account_id = ${accountId}
  `;
  return rows[0]?.count ?? 0;
}

async function bindingState(chatId: string): Promise<{ state: string; account_id: string } | null> {
  const rows = await sql<{ state: string; account_id: string }[]>`
    SELECT state, account_id FROM channel_bindings WHERE provider = 'telegram' AND external_id = ${chatId}
  `;
  return rows[0] ?? null;
}

let seq = 6_000_000;
function nextUpdateId(): number {
  return ++seq;
}

// ---------------------------------------------------------------------------
// AC-36: wrong secret → 401 BEFORE any processing
// ---------------------------------------------------------------------------

test('AC-36: webhook with wrong secret → 401, zero rows written', async () => {
  const updateId = nextUpdateId();
  const before = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM inbox_events`;
  const res = await webhookRoute(
    makeRequest('/api/webhooks/telegram', {
      body: { update_id: updateId, message: { message_id: 1, chat: { id: 5 }, text: 'x' } },
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret-value' },
    }),
  );
  assertStatus(res, 401);
  const after_ = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM inbox_events`;
  assert.equal(after_[0]!.count, before[0]!.count, 'no inbox row on bad secret');
  const jobs = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs WHERE dedupe_key = ${'tg_update:' + updateId}
  `;
  assert.equal(jobs[0]!.count, 0, 'no outbox job on bad secret');
});

test('AC-36: missing secret header → 401 (fail closed, nothing processed)', async () => {
  const res = await webhookRoute(
    makeRequest('/api/webhooks/telegram', { body: { update_id: nextUpdateId(), message: { message_id: 1, chat: { id: 5 } } } }),
  );
  assertStatus(res, 401);
});

// ---------------------------------------------------------------------------
// AC-37: replayed update_id → 200 twice, one inbox row, one outbox job
// ---------------------------------------------------------------------------

test('AC-37: duplicate update → 200 both times, ONE inbox row, ONE outbox job', async () => {
  const updateId = nextUpdateId();
  const res1 = await sendUpdate(990001, '/help', updateId);
  const res2 = await sendUpdate(990001, '/help', updateId); // replay
  assertStatus(res1, 200);
  assertStatus(res2, 200);

  const inbox = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM inbox_events
    WHERE provider = 'telegram' AND external_event_id = ${String(updateId)}
  `;
  assert.equal(inbox[0]!.count, 1);
  const jobs = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs WHERE dedupe_key = ${'tg_update:' + updateId}
  `;
  assert.equal(jobs[0]!.count, 1);
});

test('webhook: malformed update after valid secret → 400, no row', async () => {
  const res = await webhookRoute(
    makeRequest('/api/webhooks/telegram', {
      body: { update_id: 'not-an-int' },
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_HEADER },
    }),
  );
  assertStatus(res, 400);
  const inbox = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM inbox_events WHERE external_event_id = 'not-an-int'
  `;
  assert.equal(inbox[0]!.count, 0);
});

// ---------------------------------------------------------------------------
// Two-sided binding (AC-11): challenge → web confirm → /start
// ---------------------------------------------------------------------------

interface WebUser {
  cookie: string;
  accountId: string;
}

async function login(prefix: string): Promise<WebUser> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `Bind ${prefix}`, languages: ['en'] },
      cookie,
    }),
  );
  assertStatus(res, 200);
  return { cookie, accountId: await accountIdFromCookie(cookie) };
}

async function createChallenge(cookie: string): Promise<{ token: string; challengeId: string }> {
  const res = await challengeRoute(makeRequest('/api/channels/telegram/challenge', { body: {}, cookie }));
  assertStatus(res, 201);
  const body = (await res.json()) as { challenge: { id: string }; deep_link: string };
  const m = /\?start=link_(.+)$/.exec(body.deep_link);
  assert.ok(m, 'deep link must carry the link_ token');
  return { token: m![1]!, challengeId: body.challenge.id };
}

test('binding: unauthenticated challenge/confirm → 401', async () => {
  const res1 = await challengeRoute(makeRequest('/api/channels/telegram/challenge', { body: {} }));
  assertStatus(res1, 401);
  const res2 = await confirmRoute(makeRequest('/api/channels/telegram/confirm', { body: { token: 'x' } }));
  assertStatus(res2, 401);
});

test('binding: challenge deep link points at the bot username with start=link_', async () => {
  const u = await login('deeplink');
  const res = await challengeRoute(makeRequest('/api/channels/telegram/challenge', { body: {}, cookie: u.cookie }));
  assertStatus(res, 201);
  const body = (await res.json()) as { deep_link: string };
  assert.match(body.deep_link, /^https:\/\/t\.me\/WELCOME_test_bot\?start=link_/);
});

test('AC-11: /start with valid token but NO web confirm → binding NOT created', async () => {
  const u = await login('bind1');
  const { token } = await createChallenge(u.cookie);
  const chatId = 990100;

  const res = await sendUpdate(chatId, `/start link_${token}`, nextUpdateId());
  assertStatus(res, 200);
  await drainWorker(new MockTelegramTransport());

  assert.equal(await bindingState(String(chatId)), null, 'no binding without web-side confirmation');
  assert.equal(await accountConsentCount(u.accountId), 0, '/start never writes consent rows');
});

test('AC-11 positive: confirm (web) + /start (telegram) → binding active, zero consent rows', async () => {
  const u = await login('bind2');
  const { token, challengeId } = await createChallenge(u.cookie);
  const chatId = 990200;

  const confirm = await confirmRoute(makeRequest('/api/channels/telegram/confirm', { body: { token }, cookie: u.cookie }));
  assertStatus(confirm, 200);

  await sendUpdate(chatId, `/start link_${token}`, nextUpdateId());
  await drainWorker(new MockTelegramTransport());

  const binding = await bindingState(String(chatId));
  assert.ok(binding, 'binding created after two-sided confirmation');
  assert.equal(binding!.state, 'active');
  assert.equal(binding!.account_id, u.accountId);

  const challenge = await sql<{ consumed_at: Date | null; proof_flags: Record<string, unknown> }[]>`
    SELECT consumed_at, proof_flags FROM link_challenges WHERE id = ${challengeId}
  `;
  assert.ok(challenge[0]!.consumed_at, 'challenge consumed');
  assert.equal(challenge[0]!.proof_flags['web_confirmed'], true);

  const audits = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM audit_events
    WHERE action = 'channel.linked' AND actor_account_id = ${u.accountId}
  `;
  assert.ok((audits[0]!.count ?? 0) >= 1, 'channel.linked audited');
  assert.equal(await accountConsentCount(u.accountId), 0, 'zero consent_events from the binding flow');

  const reply = await sql<{ status: string }[]>`
    SELECT oj.status FROM outbox_jobs oj WHERE oj.dedupe_key = ${'tg_link_confirm:' + challengeId}
  `;
  assert.ok(reply[0], 'link confirmation reply enqueued');
});

test('AC-11 negative: another web session cannot confirm a stolen challenge (404, session-bound)', async () => {
  const owner = await login('bind3');
  const attacker = await login('bind4');
  const { token } = await createChallenge(owner.cookie);

  const confirm = await confirmRoute(
    makeRequest('/api/channels/telegram/confirm', { body: { token }, cookie: attacker.cookie }),
  );
  assertStatus(confirm, 404);

  const chatId = 990300;
  await sendUpdate(chatId, `/start link_${token}`, nextUpdateId());
  await drainWorker(new MockTelegramTransport());
  const binding = await bindingState(String(chatId));
  assert.ok(!binding || binding.account_id !== attacker.accountId, 'stolen token never binds the attacker');
});

test('/start: no token and bad token → instructions reply, no binding, NO consent rows', async () => {
  const chatId = 990400;
  await sendUpdate(chatId, '/start', nextUpdateId());
  await sendUpdate(chatId, '/start link_totally_invalid_token_1234567890', nextUpdateId());
  // F-07: after the mock sends a reply, its durable payload is minimized —
  // the copy text is asserted from the transport record instead.
  const mock = new MockTelegramTransport();
  await drainWorker(mock);

  assert.equal(await bindingState(String(chatId)), null);
  const sentReplies = mock.sent.filter((t) => t.chatId === String(chatId));
  assert.ok(sentReplies.length >= 2, 'instructions replies enqueued (and sent)');
  const joined = sentReplies.map((r) => String(r.text)).join('\n');
  assert.match(joined, /НЕ согласие/, 'copy states Start is NOT consent');
  const minimized = await sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM outbox_jobs WHERE kind = 'telegram_reply' AND payload->>'chat_id' = ${String(chatId)}
  `;
  for (const row of minimized) {
    assert.equal(row.payload['text'], undefined, 'sent reply payload must be minimized (F-07)');
  }
});

test('/start: non-command text from an unknown chat → ignored, no dialog with strangers', async () => {
  const chatId = 990500;
  await sendUpdate(chatId, 'hello bot!', nextUpdateId());
  await drainWorker(new MockTelegramTransport());
  const replies = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs
    WHERE kind = 'telegram_reply' AND payload->>'chat_id' = ${String(chatId)}
  `;
  assert.equal(replies[0]!.count, 0, 'no reply to strangers');
});

// ---------------------------------------------------------------------------
// Known-binding commands
// ---------------------------------------------------------------------------

test('/stop: binding revoked, queued sends suppressed (AC-39); command replies answered', async () => {
  const u = await createUser('stop');
  const chatId = 990600;
  await bindTelegram(u.accountId, String(chatId));

  // Queued BEFORE /stop but with a far-future due_at so this tick processes
  // only the updates; /stop must then suppress the still-pending job directly.
  const { id: pendingJob } = await sql.begin(async (tx) => {
    const r = await tx<{ id: string }[]>`
      INSERT INTO outbox_jobs (dedupe_key, kind, channel, purpose, payload, due_at)
      VALUES ('stop-test-job', 'intro_requested_notice', 'telegram', 'service_channel',
              ${tx.json({ account_id: u.accountId, text: 'notice' })}, now() + interval '1 hour')
      RETURNING id
    `;
    return { id: r[0]!.id };
  });

  // Phase 1: four read/command replies while the channel is still active.
  await sendUpdate(chatId, '/privacy', nextUpdateId());
  await sendUpdate(chatId, '/help', nextUpdateId());
  await sendUpdate(chatId, '/delete', nextUpdateId());
  await sendUpdate(chatId, '/matches', nextUpdateId());
  await drainWorker(new MockTelegramTransport());
  // Phase 2: /stop revokes the binding and suppresses everything still pending.
  await sendUpdate(chatId, '/stop', nextUpdateId());
  await drainWorker(new MockTelegramTransport());

  const binding = await bindingState(String(chatId));
  assert.ok(binding);
  assert.equal(binding!.state, 'revoked', '/stop revokes the binding');

  const audits = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM audit_events
    WHERE action = 'channel.revoked' AND actor_account_id = ${u.accountId}
  `;
  assert.ok((audits[0]!.count ?? 0) >= 1, 'channel.revoked audited');

  // The pre-existing notification job got suppressed by /stop.
  const stoppedJob = await jobRow(pendingJob);
  assert.equal(stoppedJob.status, 'suppressed');
  const attempts = await attemptRows(pendingJob);
  assert.equal(attempts[0]!.code, 'channel_revoked');

  // Command replies were enqueued (sent via the mock during the tick).
  const replies = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs
    WHERE kind = 'telegram_reply' AND payload->>'chat_id' = ${String(chatId)}
  `;
  assert.equal(replies[0]!.count, 5, 'exactly one reply per command');
});

test('/stop itself never writes consent rows', async () => {
  const u = await createUser('stop2');
  const chatId = 990700;
  await bindTelegram(u.accountId, String(chatId));
  await sendUpdate(chatId, '/stop', nextUpdateId());
  await drainWorker(new MockTelegramTransport());
  assert.equal(await accountConsentCount(u.accountId), 0);
});

test('replayed /start update cannot double-bind or double-consume', async () => {
  const u = await login('bind5');
  const { token } = await createChallenge(u.cookie);
  await confirmRoute(makeRequest('/api/channels/telegram/confirm', { body: { token }, cookie: u.cookie }));

  const chatId = 990800;
  const updateId = nextUpdateId();
  await sendUpdate(chatId, `/start link_${token}`, updateId);
  await sendUpdate(chatId, `/start link_${token}`, updateId); // replay → deduped
  const jobs = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs WHERE dedupe_key = ${'tg_update:' + updateId}
  `;
  assert.equal(jobs[0]!.count, 1);
  await drainWorker(new MockTelegramTransport());
  const binding = await bindingState(String(chatId));
  assert.ok(binding);
  assert.equal(binding!.account_id, u.accountId);

  // Consumed challenge cannot be used a second time from another chat.
  const otherChat = 990801;
  await sendUpdate(otherChat, `/start link_${token}`, nextUpdateId());
  await drainWorker(new MockTelegramTransport());
  assert.equal(await bindingState(String(otherChat)), null, 'second binding attempt must fail');
});

// ---------------------------------------------------------------------------
// Phase 5 replay hardening: staleness window + no false dedupe
// ---------------------------------------------------------------------------

/** Sends a raw update body through the webhook route. */
function sendRaw(body: unknown): Promise<Response> {
  return webhookRoute(
    makeRequest('/api/webhooks/telegram', {
      body,
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_HEADER },
    }),
  );
}

test('replay hardening: same update_id replays once (accepted:false) — UNIQUE dedupe', async () => {
  const updateId = nextUpdateId();
  const first = await sendRaw({
    update_id: updateId,
    message: { message_id: updateId, from: { id: 777001 }, chat: { id: 777001 }, text: '/start' },
  });
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { accepted: boolean }).accepted, true);

  const second = await sendRaw({
    update_id: updateId,
    message: { message_id: updateId, from: { id: 777001 }, chat: { id: 777001 }, text: '/start' },
  });
  assert.equal(second.status, 200); // provider must not retry on dedupe
  assert.equal(((await second.json()) as { accepted: boolean }).accepted, false);

  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM inbox_events WHERE external_event_id = ${String(updateId)}
  `;
  assert.equal(rows[0]!.count, 1);
});

test('replay hardening: DIFFERENT update_id with identical payload still processes (no false dedupe)', async () => {
  const payload = { message: { message_id: 424242, from: { id: 777002 }, chat: { id: 777002 }, text: '/start' } };
  const id1 = nextUpdateId();
  const id2 = nextUpdateId();

  const first = await sendRaw({ update_id: id1, ...payload });
  const second = await sendRaw({ update_id: id2, ...payload });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(((await first.json()) as { accepted: boolean }).accepted, true);
  assert.equal(((await second.json()) as { accepted: boolean }).accepted, true);

  const rows = await sql<{ id: number; received_at: Date }[]>`
    SELECT id, received_at FROM inbox_events WHERE external_event_id IN (${String(id1)}, ${String(id2)})
  `;
  assert.equal(rows.length, 2, 'both updates must be durably stored');
  for (const row of rows) {
    const age = Date.now() - new Date(row.received_at).getTime();
    assert.ok(age >= 0 && age < 60_000, 'received_at must be recorded at accept time');
  }
});

test('replay hardening: stale update (older than the window) → 400 stale_update, nothing stored', async () => {
  const updateId = nextUpdateId();
  const staleDate = Math.floor(Date.now() / 1000) - 25 * 3600;
  const res = await sendRaw({
    update_id: updateId,
    message: { message_id: updateId, from: { id: 777003 }, chat: { id: 777003 }, text: '/start', date: staleDate },
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code: string }).code, 'stale_update');

  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM inbox_events WHERE external_event_id = ${String(updateId)}
  `;
  assert.equal(rows[0]!.count, 0);
});

test('replay hardening: fresh update with valid date is accepted', async () => {
  const updateId = nextUpdateId();
  const res = await sendRaw({
    update_id: updateId,
    message: {
      message_id: updateId, from: { id: 777004 }, chat: { id: 777004 }, text: '/start',
      date: Math.floor(Date.now() / 1000) - 60,
    },
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { accepted: boolean }).accepted, true);
});

// ---------------------------------------------------------------------------
// Lease-churn regression: a processed telegram_update job must end terminal
// 'delivered' — the old defect left it 'leased', so every lease expiry (60s)
// re-claimed and reprocessed it forever.
// ---------------------------------------------------------------------------

async function updateJobId(updateId: number): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM outbox_jobs WHERE dedupe_key = ${'tg_update:' + updateId}
  `;
  if (!rows[0]) throw new Error(`outbox job for update ${updateId} not found`);
  return rows[0]!.id;
}

test('regression: stranger update processed → delivered, never re-claimed after lease expiry', async () => {
  const chatId = 990510;
  const updateId = nextUpdateId();
  const res = await sendRaw({
    update_id: updateId,
    message: {
      message_id: updateId, from: { id: chatId }, chat: { id: chatId }, text: 'hi',
      date: Math.floor(Date.now() / 1000) - 60, // fresh — inside the staleness window
    },
  });
  assert.equal(res.status, 200);
  const jobId = await updateJobId(updateId);

  const mock = new MockTelegramTransport();
  const first = await tickOnce({ transport: mock });
  assert.ok(
    first.results.some((r) => r.job_id === jobId && r.outcome === 'processed:ignored_stranger'),
    'tick reports the update as processed:ignored_stranger',
  );
  const afterTick1 = await jobRow(jobId);
  assert.equal(afterTick1.status, 'delivered', 'processed update is terminal delivered, not leased');
  assert.equal(afterTick1.attempt, 1, 'exactly one processing try recorded');
  const lease = await sql<{ lease_until: Date | null }[]>`
    SELECT lease_until FROM outbox_jobs WHERE id = ${jobId}
  `;
  assert.equal(lease[0]!.lease_until, null, 'terminal job holds no lease');

  // Simulate the stale lease the old defect left behind: even with an expired
  // lease_until a delivered job must never be re-claimed or reprocessed.
  await sql`UPDATE outbox_jobs SET lease_until = now() - interval '1 second' WHERE id = ${jobId}`;
  const second = await tickOnce({ transport: mock });
  assert.ok(!second.results.some((r) => r.job_id === jobId), 'delivered job is not re-claimed');
  const afterTick2 = await jobRow(jobId);
  assert.equal(afterTick2.status, 'delivered', 'stays delivered across lease expiry');
  assert.equal(afterTick2.attempt, afterTick1.attempt, 'attempt must not grow');
  const replies = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs
    WHERE kind = 'telegram_reply' AND payload->>'chat_id' = ${String(chatId)}
  `;
  assert.equal(replies[0]!.count, 0, 'still no dialog with strangers');
});

test('regression: /start without token processed once — one instructions reply across lease expiry', async () => {
  const chatId = 990511;
  const updateId = nextUpdateId();
  await sendUpdate(chatId, '/start', updateId);
  const jobId = await updateJobId(updateId);

  const mock = new MockTelegramTransport();
  await tickOnce({ transport: mock }); // handles the update → delivered; its reply is enqueued but stays pending this tick
  await sql`UPDATE outbox_jobs SET lease_until = now() - interval '1 second' WHERE id = ${jobId}`;
  await tickOnce({ transport: mock }); // old bug: re-claim + reprocess the update here; now only the reply is claimed

  const row = await jobRow(jobId);
  assert.equal(row.status, 'delivered', 'stays delivered across lease expiry');
  assert.equal(row.attempt, 1, 'no reprocessing after lease expiry');
  const replies = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs
    WHERE kind = 'telegram_reply' AND payload->>'chat_id' = ${String(chatId)}
  `;
  assert.equal(replies[0]!.count, 1, 'exactly one instructions reply — no duplicate');
  assert.equal(mock.sent.filter((t) => t.chatId === String(chatId)).length, 1, 'no double-send to the chat');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { createRequire } from 'node:module';
import { POST as webhookRoute } from '../../src/app/api/webhooks/telegram/route';
import { runPostResponseTick } from '../../src/infra/post-response-tick';
import { getSql, closeSql } from '../../src/lib/db';
import { MockTelegramTransport } from '../../src/integrations/telegram/mock-transport';
import type { ChannelTransport } from '../../src/integrations/telegram/transport';
import { makeRequest } from './helpers';
import { bindTelegram, createUser, drainWorker, jobRow, attemptRows } from './phase3-helpers';

/**
 * Webhook post-response fast path (`after()`), latency fix.
 *
 * What is asserted here: after a webhook POST the queued update reaches a
 * TERMINAL state (and its reply is actually handed to the transport) inside the
 * same request, WITHOUT any manual/external worker tick — plus the invariants
 * that must not regress: dedupe, the 200-before-processing order, durability
 * when the fast path is unavailable, and error containment.
 */

// Same wiring as the worker-tick endpoint (see worker-tick.test.ts): the route
// selects its transport itself, which needs dev + TELEGRAM_MOCK=1. The token is
// removed so a developer's shell can never make this file hit the real Bot API.
process.env.TELEGRAM_MOCK = '1';
delete process.env.TELEGRAM_BOT_TOKEN;

after(async () => {
  await closeSql();
});

const sql = getSql();
const WEBHOOK_HEADER = 'integration-telegram-webhook-secret';

interface AfterCapture {
  tasks: Array<() => unknown>;
  restore: () => void;
}

const requireFromTest = createRequire(import.meta.url);

/**
 * Captures what the route hands to Next's `after()`.
 *
 * No Next server runs under `node --test`, and `next/server`'s after() throws
 * E468 outside a request scope — so the test replaces that one export with a
 * recorder (the SAME module instance the route imported, so the production call
 * site is what gets recorded), runs the webhook, and then invokes the recorded
 * callbacks exactly where Next would: once the response is closed.
 */
function captureAfter(): AfterCapture {
  const nextServer = requireFromTest('next/server') as {
    after: (task: () => void | Promise<void>) => void;
  };
  const original = nextServer.after;
  const tasks: Array<() => unknown> = [];
  nextServer.after = (task) => {
    tasks.push(task);
  };
  return {
    tasks,
    restore: () => {
      nextServer.after = original;
    },
  };
}

/** POSTs a message update through the real webhook route. */
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

let seq = 7_000_000;
function nextUpdateId(): number {
  return ++seq;
}

async function updateJobId(updateId: number): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM outbox_jobs WHERE dedupe_key = ${'tg_update:' + updateId}
  `;
  if (!rows[0]) throw new Error(`outbox job for update ${updateId} not found`);
  return rows[0]!.id;
}

async function replyJobs(chatId: number): Promise<{ id: string; status: string }[]> {
  return sql<{ id: string; status: string }[]>`
    SELECT id, status FROM outbox_jobs
    WHERE kind = 'telegram_reply' AND payload->>'chat_id' = ${String(chatId)}
    ORDER BY created_at
  `;
}

// ---------------------------------------------------------------------------
// Fast path: response first, processing immediately after (no external tick)
// ---------------------------------------------------------------------------

test('after(): webhook 200 → deferred tick drives the update to a terminal state and sends its reply, no external tick', async () => {
  await drainWorker(new MockTelegramTransport()); // empty queue: only our own job can be claimed

  const user = await createUser('after-fast');
  const chatId = 7_100_001;
  await bindTelegram(user.accountId, String(chatId));
  const updateId = nextUpdateId();

  const capture = captureAfter();
  let res: Response;
  try {
    res = await sendUpdate(chatId, '/help', updateId);
  } finally {
    capture.restore();
  }

  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { accepted: boolean }).accepted, true);
  assert.equal(capture.tasks.length, 1, 'exactly one post-response task is deferred via after()');

  // Durability first: the response was produced while the job was still pending.
  const jobId = await updateJobId(updateId);
  const beforeFlush = await jobRow(jobId);
  assert.equal(beforeFlush.status, 'pending', 'nothing is processed before the response is out');
  assert.equal((await attemptRows(jobId)).length, 0, 'no delivery attempt before the response');

  // Emulate the response close — this is where Next runs the after() callbacks.
  for (const task of capture.tasks) await task();

  const processed = await jobRow(jobId);
  assert.equal(processed.status, 'delivered', 'update processed by the after() callback alone');
  const updateAttempts = await attemptRows(jobId);
  assert.equal(updateAttempts.length, 1, 'exactly one processing try');
  assert.equal(updateAttempts[0]!.state, 'processed');

  // …and round 2 of the same deferred drain sent the reply the handler queued.
  const replies = await replyJobs(chatId);
  assert.equal(replies.length, 1, 'exactly one reply queued');
  assert.equal(replies[0]!.status, 'sent', 'reply handed to the transport inside the after() window');
  const replyAttempts = await attemptRows(replies[0]!.id);
  assert.equal(replyAttempts[0]!.state, 'sent', 'reply recorded as sent, no cron involvement');
});

// ---------------------------------------------------------------------------
// Dedupe (AC-37) survives the fast path
// ---------------------------------------------------------------------------

test('after(): replayed update_id → 200, no deferred tick, no double action', async () => {
  await drainWorker(new MockTelegramTransport());

  const user = await createUser('after-dup');
  const chatId = 7_100_002;
  await bindTelegram(user.accountId, String(chatId));
  const updateId = nextUpdateId();

  const first = captureAfter();
  let res1: Response;
  try {
    res1 = await sendUpdate(chatId, '/help', updateId);
  } finally {
    first.restore();
  }
  assert.equal(res1.status, 200);
  assert.equal(first.tasks.length, 1);
  for (const task of first.tasks) await task();
  assert.equal((await jobRow(await updateJobId(updateId))).status, 'delivered');
  assert.equal((await replyJobs(chatId)).length, 1);

  // Replay: deduped, and it must not even schedule another drain.
  const replay = captureAfter();
  let res2: Response;
  try {
    res2 = await sendUpdate(chatId, '/help', updateId);
  } finally {
    replay.restore();
  }
  assert.equal(res2.status, 200, 'provider must not retry on dedupe');
  assert.equal(((await res2.json()) as { accepted: boolean }).accepted, false);
  assert.equal(replay.tasks.length, 0, 'a deduped update defers no post-response work');

  const inbox = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM inbox_events WHERE external_event_id = ${String(updateId)}
  `;
  assert.equal(inbox[0]!.count, 1, 'one inbox row');
  assert.equal((await replyJobs(chatId)).length, 1, 'no second action for the replay');
});

// ---------------------------------------------------------------------------
// Durability when the fast path is not available
// ---------------------------------------------------------------------------

test('after(): no request scope (after() throws) → webhook still 200 and the job stays pending for the backstop', async () => {
  await drainWorker(new MockTelegramTransport());

  const user = await createUser('after-noscope');
  const chatId = 7_100_003;
  await bindTelegram(user.accountId, String(chatId));
  const updateId = nextUpdateId();

  // Unpatched: next/server's after() throws E468 outside a request scope.
  const res = await sendUpdate(chatId, '/help', updateId);
  assert.equal(res.status, 200, 'scheduling failure must never break the webhook response');

  const jobId = await updateJobId(updateId);
  const row = await jobRow(jobId);
  assert.equal(row.status, 'pending', 'job is durable and unclaimed — the cron backstop picks it up');
  assert.equal(row.attempt, 0, 'no processing attempted');
  assert.equal((await attemptRows(jobId)).length, 0);
  assert.equal((await replyJobs(chatId)).length, 0, 'nothing happened without an explicit tick');
});

// ---------------------------------------------------------------------------
// Error containment
// ---------------------------------------------------------------------------

test('after(): a transport error inside the drain is contained — the tick never throws and the job is requeued, not lost', async () => {
  await drainWorker(new MockTelegramTransport());

  const user = await createUser('after-error');
  const chatId = 7_100_004;
  await bindTelegram(user.accountId, String(chatId));
  const updateId = nextUpdateId();

  const res = await sendUpdate(chatId, '/help', updateId);
  assert.equal(res.status, 200);

  const exploding: ChannelTransport = {
    name: 'exploding',
    send: () => {
      throw new Error('socket hang up');
    },
  };

  // Must resolve: the post-response path swallows its own failures.
  await runPostResponseTick({ transport: exploding });

  assert.equal((await jobRow(await updateJobId(updateId))).status, 'delivered', 'the update itself was processed');

  const replies = await replyJobs(chatId);
  assert.equal(replies.length, 1);
  const reply = await jobRow(replies[0]!.id);
  assert.equal(reply.status, 'pending', 'transport failure requeues with backoff — never lost, never stuck leased');
  assert.equal(reply.attempt, 1);
  assert.ok(reply.due_at.getTime() > Date.now(), 'retry scheduled in the future');
  assert.equal(replies[0]!.status, 'pending');
});

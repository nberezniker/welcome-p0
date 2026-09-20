import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { getSql, closeSql } from '../../src/lib/db';
import { runWorker, tickOnce } from '../../src/infra/worker';
import { enqueueOutbox } from '../../src/infra/outbox';
import type { ChannelTransport } from '../../src/integrations/telegram/transport';

/**
 * What actually happens to an in-flight job and to an acquired lease on SIGTERM.
 *
 * WHY THIS IS A TEST AND NOT A PARAGRAPH. `runWorker` has always carried the
 * comment "SIGTERM/SIGINT → graceful drain, then exit", and the handler is four
 * lines long (`running = false`) — small enough that the claim about it was never
 * earned by observation. The honest question is what the flag does to work that
 * is already in progress:
 *
 *   - a job ALREADY CLAIMED when the signal arrives must still be finished and
 *     finalised, so its lease is released and the delivery is not duplicated;
 *   - a job whose lease is ABANDONED (SIGKILL, host power loss — anything that
 *     skips the handler) must come back on its own, with the attempt count
 *     incremented, which is what makes the guarantee at-least-once rather than
 *     at-most-once.
 *
 * Both are asserted below against the real worker, a real database and a real
 * lease. The process-level half (an OS signal delivered to a running worker, the
 * exit code, the drain line) is run by hand and recorded in SELF_HOSTING.md §4.7.
 */

const sql = getSql();

after(async () => {
  await closeSql();
});

interface ShutdownJobRow {
  status: string;
  attempt: number;
  lease_until: Date | null;
}

async function jobState(id: string): Promise<ShutdownJobRow> {
  const rows = await sql<ShutdownJobRow[]>`SELECT status, attempt, lease_until FROM outbox_jobs WHERE id = ${id}`;
  if (!rows[0]) throw new Error(`job ${id} disappeared`);
  return rows[0];
}

/** Enqueues a job the worker can deliver with no account/consent preconditions:
 * no `account_id` in the payload means the explicit `chat_id` addresses it. */
async function enqueueDeliverableJob(): Promise<{ id: string; dedupeKey: string }> {
  const dedupeKey = `shutdown-${randomUUID()}`;
  const job = await sql.begin((tx) =>
    enqueueOutbox(tx, {
      dedupeKey,
      kind: 'telegram_reply',
      subjectId: null,
      channel: 'telegram',
      purpose: 'service_channel',
      payload: { chat_id: 'shutdown-chat', text: 'shutdown test' },
    }),
  );
  return { id: job.id, dedupeKey };
}

/** Captures the worker's own log lines (the logger's only sink is console). */
async function withCapturedLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const sink = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.log = sink as typeof console.log;
  console.warn = sink as typeof console.warn;
  console.error = sink as typeof console.error;
  console.info = sink as typeof console.info;
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
  }
}

test('worker shutdown: SIGTERM while a job is in flight finishes it and releases the lease', async () => {
  const { id } = await enqueueDeliverableJob();
  // Dated far in the past so this job is overwhelmingly likely to be the FIRST
  // one claimed — the test suite shares one database, so which job is in flight
  // is otherwise the queue's decision, not this test's.
  await sql`UPDATE outbox_jobs SET due_at = now() - interval '1 day' WHERE id = ${id}`;

  // A transport that reports when it has been entered and then waits, so the
  // signal is delivered at a moment this test controls rather than in a race.
  const attempted: string[] = [];
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport: ChannelTransport = {
    name: 'shutdown_test_transport',
    async send(task) {
      attempted.push(task.jobId);
      markStarted();
      await held;
      return { state: 'sent', providerMessageId: 'shutdown-1' };
    },
  };

  const { result, lines } = await withCapturedLogs(async () => {
    const worker = runWorker({ sql, transport, emailTransport: null, cleanup: false, followupScan: false });
    await started;
    // In flight NOW: the job the transport is holding is claimed and leased.
    const inFlightId = attempted[0]!;
    const inFlight = await jobState(inFlightId);
    assert.equal(inFlight.status, 'leased', 'the job must be leased while the transport is running');
    assert.notEqual(inFlight.lease_until, null);

    // The signal arrives mid-flight, then the transport finishes its work. The
    // order matters: this is precisely the case the "graceful drain" comment
    // claimed and never showed.
    process.emit('SIGTERM');
    release();
    await worker;
    return 'drained';
  });

  assert.equal(result, 'drained', 'runWorker must resolve — the loop is expected to exit');

  // THE IN-FLIGHT JOB IS FINISHED. Asserted on the job the transport was actually
  // holding rather than on the one this test enqueued: "in flight" is a property
  // of the moment, and a suite that shares a database cannot promise which row
  // that is. (In practice it is this test's job, dated a day in the past.)
  const inFlightId = attempted[0]!;
  const finished = await jobState(inFlightId);
  assert.equal(finished.status, 'sent', 'an in-flight job must be FINISHED, not abandoned');
  assert.equal(finished.lease_until, null, 'the lease must be released by the finalizer');

  // …and the queue is left with no lease held at all: the property an operator
  // actually cares about, and the one a SIGKILL would violate.
  const stillLeased = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_jobs WHERE status = 'leased'`;
  assert.equal(stillLeased[0]!.n, 0, 'a drained worker must leave no lease behind');

  // This test's own job ends in one of the two honest states — delivered (it was
  // the one in flight) or released untouched (the signal arrived before it).
  const mine = await jobState(id);
  assert.ok(['sent', 'pending'].includes(mine.status), `unexpected status ${mine.status}`);
  if (mine.status === 'pending') assert.equal(mine.lease_until, null);

  assert.equal(
    lines.some((line) => line.includes('worker_drained')),
    true,
    'the drain must be observable in the log, not just in this assertion',
  );
});

test('worker shutdown: jobs claimed but not yet attempted are RELEASED, not sent', async () => {
  // The case a real run surfaced: claimJobs takes a BATCH (up to 10), so a signal
  // that arrives while job #1 is in flight used to be honoured only after the
  // whole batch had been sent — a drain bounded by 10 × the 10s transport
  // timeout, which any supervisor's grace period (Docker default: 10s) would
  // interrupt with a SIGKILL. Now the one job in flight finishes and the rest are
  // released immediately, with no attempt burned.
  //
  // THE ASSERTION IS AN INVARIANT, NOT A GUESS ABOUT ORDER. The suite shares one
  // database with every other integration file, so "which job is claimed first"
  // is not this test's to decide — an earlier version assumed the two jobs it
  // created would be first in `due_at` order and failed exactly once in a full
  // gate run because a leftover job from another suite was older. What is true
  // regardless of order is: at most one job can be IN FLIGHT, that one finishes,
  // and everything else the tick held is released untouched. The set the tick
  // held is snapshotted from the database at the moment the send is entered.
  const mine = [await enqueueDeliverableJob(), await enqueueDeliverableJob()];
  // Dated far in the past only to make it overwhelmingly likely that BOTH of this
  // test's jobs are in the claimed batch (the assertion below says so, so a
  // future queue state that breaks it fails loudly instead of silently weakening
  // the test).
  await sql`UPDATE outbox_jobs SET due_at = now() - interval '1 day' WHERE id = ${mine[0]!.id}`;
  await sql`UPDATE outbox_jobs SET due_at = now() - interval '23 hours' WHERE id = ${mine[1]!.id}`;
  const mineIds = new Set(mine.map((j) => j.id));

  const attempted: string[] = [];
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport: ChannelTransport = {
    name: 'shutdown_batch_transport',
    async send(task) {
      attempted.push(task.jobId);
      markStarted();
      await held;
      return { state: 'sent', providerMessageId: 'batch-1' };
    },
  };

  let heldByTick: { id: string; attempt: number }[] = [];
  const { lines } = await withCapturedLogs(async () => {
    const worker = runWorker({ sql, transport, emailTransport: null, cleanup: false, followupScan: false });
    await started;
    // In flight NOW: every row this tick owns is exactly the leased set.
    heldByTick = await sql<{ id: string; attempt: number }[]>`
      SELECT id, attempt FROM outbox_jobs WHERE status = 'leased'
    `;
    const heldIds = new Set(heldByTick.map((r) => r.id));
    assert.equal(attempted.length, 1, 'exactly one job can be in flight');
    assert.equal(heldIds.has(attempted[0]!), true, 'the in-flight job is leased by this tick');
    for (const id of mineIds) {
      assert.equal(heldIds.has(id), true, 'both jobs this test created must be in the claimed batch');
    }
    assert.ok(heldByTick.length >= 2, 'the batch must hold more than the in-flight job, or there is nothing to release');

    process.emit('SIGTERM');
    release();
    await worker;
  });

  // The one job in flight was FINISHED, never cut off.
  assert.equal((await jobState(attempted[0]!)).status, 'sent', 'the in-flight job is finished, never cut off');
  assert.equal(attempted.length, 1, 'no further job may be attempted after the signal');

  // Everything else the same tick had claimed went back to the queue untouched.
  const leftovers = heldByTick.filter((r) => r.id !== attempted[0]);
  assert.ok(leftovers.length >= 1);
  for (const before of leftovers) {
    const row = await jobState(before.id);
    assert.equal(row.status, 'pending', `job ${before.id} must go back to the queue`);
    assert.equal(row.lease_until, null, `job ${before.id} must not keep a lease`);
    assert.equal(row.attempt, before.attempt, `job ${before.id} was never attempted, so its try count must not move`);
  }
  assert.equal(
    lines.some((line) => line.includes('worker_released_unattempted')),
    true,
    'the release must be observable in the log',
  );
});

test('worker shutdown: an abandoned lease is requeued with backoff, then re-delivered (at-least-once)', async () => {
  // The SIGKILL case: the handler never ran, so the row is still 'leased' with an
  // expired lease. This is what "the tick completed" does NOT cover, and it is
  // why the guarantee is AT-LEAST-once: the job comes back — which also means a
  // delivery that did happen can be repeated.
  const { id } = await enqueueDeliverableJob();
  const abandoned = await sql`
    UPDATE outbox_jobs
    SET status = 'leased', lease_until = now() - interval '5 seconds', attempt = 1, due_at = now()
    WHERE id = ${id}
    RETURNING attempt
  `;
  assert.equal(abandoned.length, 1);

  const sent: string[] = [];
  const transport: ChannelTransport = {
    name: 'shutdown_recovery_transport',
    async send(task) {
      sent.push(task.jobId);
      return { state: 'sent', providerMessageId: 'recovered-1' };
    },
  };
  const tick = () => tickOnce({ sql, transport, emailTransport: null, cleanup: false, followupScan: false });

  // Tick 1 recovers the lease. Recovery deliberately schedules the retry with the
  // worker's own quadratic backoff instead of re-sending inside a crash loop, so
  // the job is NOT delivered in this tick.
  const first = await tick();
  assert.ok(first.requeuedLeases >= 1, 'the expired lease must be requeued by the tick');

  const requeued = await jobState(id);
  assert.equal(requeued.status, 'pending');
  assert.equal(requeued.attempt, 2, 'the try count must stay honest across a crash');
  assert.equal(requeued.lease_until, null);
  assert.equal(sent.includes(id), false, 'no delivery in the recovery tick — the backoff comes first');

  const dueAt = await sql<{ in_future: boolean }[]>`
    SELECT due_at > now() AS in_future FROM outbox_jobs WHERE id = ${id}
  `;
  assert.equal(dueAt[0]!.in_future, true, 'the retry must be scheduled, not immediate');

  // Once the backoff elapses (forced here rather than waited out), the next tick
  // delivers it: the crash cost a delay, not the job. THIS is the duplicate-send
  // window SELF_HOSTING.md §4.8 names. Dated a day in the past so the shared queue
  // cannot keep it out of the claim batch.
  await sql`UPDATE outbox_jobs SET due_at = now() - interval '1 day' WHERE id = ${id}`;
  await tick();

  const delivered = await jobState(id);
  assert.equal(delivered.status, 'sent', 'the recovered job must be delivered');
  assert.equal(delivered.attempt, 3);
  assert.equal(sent.includes(id), true, 'the recovered job is the one that was sent');
});

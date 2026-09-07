import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { getSql, closeSql } from '../../src/lib/db';
import { enqueueOutbox, applyOutcome, MAX_UNKNOWN_ATTEMPTS, type OutboxJobRow } from '../../src/infra/outbox';
import { MockTelegramTransport } from '../../src/integrations/telegram/mock-transport';
import { createUser, bindTelegram, grantConsent, withdrawConsent, makeJobDue, jobRow, attemptRows, drainWorker } from './phase3-helpers';

after(async () => {
  await closeSql();
});

const sql = getSql();

function outboundJob(userId: string, dedupeKey: string, extra: Record<string, unknown> = {}) {
  return {
    dedupeKey,
    kind: 'campaign_message' as const,
    subjectId: null,
    channel: 'telegram',
    purpose: 'service_channel',
    payload: { account_id: userId, text: 'WELCOME test message', ...extra },
  };
}

// Integration suites share one DB: earlier suites leave pending jobs behind,
// so every tick-based test drains the queue before asserting per-job state.

// ---------------------------------------------------------------------------
// enqueueOutbox — idempotency via dedupe_key
// ---------------------------------------------------------------------------

test('outbox enqueue: duplicate dedupe_key returns the existing id, one row total', async () => {
  const u = await createUser('ob');
  const first = await sql.begin((tx) => enqueueOutbox(tx, outboundJob(u.accountId, 'ob-dedupe-1')));
  const second = await sql.begin((tx) => enqueueOutbox(tx, outboundJob(u.accountId, 'ob-dedupe-1')));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  const count = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM outbox_jobs WHERE dedupe_key = 'ob-dedupe-1'
  `;
  assert.equal(count[0]?.count, 1);
});

test('outbox enqueue: default due_at uses the DB clock (immediately claimable)', async () => {
  const u = await createUser('ob');
  const { id } = await sql.begin((tx) => enqueueOutbox(tx, outboundJob(u.accountId, 'ob-due-now')));
  const row = await jobRow(id);
  assert.ok(new Date(row.due_at).getTime() <= Date.now() + 50, 'due_at must be <= now');
});

// ---------------------------------------------------------------------------
// Full lifecycle pending → leased → sent with the mock transport
// ---------------------------------------------------------------------------

test('outbox lifecycle: pending → sent, attempt row recorded, redacted (no payload)', async () => {
  const u = await createUser('ob');
  await bindTelegram(u.accountId, '777000111');
  await grantConsent(u.accountId, 'service_channel', 'global', null);
  const { id } = await sql.begin((tx) =>
    enqueueOutbox(tx, outboundJob(u.accountId, 'ob-lifecycle-1', { enforce_consent: true })),
  );

  const mock = new MockTelegramTransport();
  await drainWorker(mock);

  const row = await jobRow(id);
  assert.equal(row.status, 'sent', `expected sent, got ${row.status}`);
  assert.equal(row.attempt, 1);
  const attempts = await attemptRows(id);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.state, 'sent');
  assert.match(attempts[0]!.provider_message_id ?? '', /^mock-/);
  assert.equal(attempts[0]!.code, null);
  // Redaction: delivery_attempts never stores the message payload.
  const attemptColumns = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'delivery_attempts'
  `;
  const cols = attemptColumns.map((c) => c.column_name);
  assert.ok(!cols.includes('payload'), 'no payload column on delivery_attempts');
  assert.equal(mock.sent[0]!.text, 'WELCOME test message');
});

test('outbox: recipient without any channel → suppressed no_channel, never sent', async () => {
  const u = await createUser('ob');
  const { id } = await sql.begin((tx) => enqueueOutbox(tx, outboundJob(u.accountId, 'ob-nochannel')));
  await drainWorker(new MockTelegramTransport());
  const row = await jobRow(id);
  assert.equal(row.status, 'suppressed');
  const attempts = await attemptRows(id);
  assert.equal(attempts[0]!.state, 'suppressed');
  assert.equal(attempts[0]!.code, 'no_channel');
});

test('outbox: revoked binding → suppressed channel_revoked (AC-39 send-side)', async () => {
  const u = await createUser('ob');
  await bindTelegram(u.accountId, '777000222');
  await sql`UPDATE channel_bindings SET state = 'revoked' WHERE account_id = ${u.accountId}`;
  const { id } = await sql.begin((tx) => enqueueOutbox(tx, outboundJob(u.accountId, 'ob-revoked')));
  await drainWorker(new MockTelegramTransport());
  const row = await jobRow(id);
  assert.equal(row.status, 'suppressed');
  const attempts = await attemptRows(id);
  assert.equal(attempts[0]!.code, 'channel_revoked');
});

test('outbox: withdrawn consent → suppressed at send time even if the hook raced', async () => {
  const u = await createUser('ob');
  await bindTelegram(u.accountId, '777000333');
  await grantConsent(u.accountId, 'service_channel', 'global', null);
  const { id } = await sql.begin((tx) =>
    enqueueOutbox(tx, outboundJob(u.accountId, 'ob-consent', { enforce_consent: true })),
  );
  // Withdraw AFTER enqueue, then make the job due so the worker re-checks.
  await withdrawConsent(u.accountId, 'service_channel', 'global', null);
  await makeJobDue(id);
  await drainWorker(new MockTelegramTransport());
  const row = await jobRow(id);
  assert.equal(row.status, 'suppressed');
  const attempts = await attemptRows(id);
  assert.equal(attempts[0]!.state, 'suppressed');
  assert.equal(attempts[0]!.code, 'consent_revoked');
});

test('outbox: permanent 4xx → failed, no retry on subsequent ticks', async () => {
  const u = await createUser('ob');
  await bindTelegram(u.accountId, '777000444');
  const { id } = await sql.begin((tx) => enqueueOutbox(tx, outboundJob(u.accountId, 'ob-4xx')));
  const failing = new MockTelegramTransport([{ state: 'failed', code: 'tg_http_403' }]);
  await drainWorker(failing);
  const row1 = await jobRow(id);
  assert.equal(row1.status, 'failed');
  assert.equal(row1.attempt, 1);
  // Second drain must NOT retry a failed job.
  const second = new MockTelegramTransport();
  await drainWorker(second);
  const row2 = await jobRow(id);
  assert.equal(row2.status, 'failed');
  assert.equal(row2.attempt, 1);
  assert.equal(second.sendCount, 0);
});

// ---------------------------------------------------------------------------
// AC-42: unknown (timeout) — max 3 attempts, then terminal unknown, never resend
// ---------------------------------------------------------------------------

test('AC-42: unknown outcomes capped at 3 attempts, then terminal, never infinite resend', async () => {
  const u = await createUser('ob');
  await bindTelegram(u.accountId, '777000555');
  const { id } = await sql.begin((tx) => enqueueOutbox(tx, outboundJob(u.accountId, 'ob-unknown')));

  // Stale jobs from other suites must not eat scripted outcomes: suppression
  // happens before the transport, so they never reach send() — but keep the
  // script long enough to be robust anyway.
  const timeoutMock = new MockTelegramTransport([
    { state: 'unknown', code: 'timeout' },
    { state: 'unknown', code: 'timeout' },
    { state: 'unknown', code: 'timeout' },
    { state: 'unknown', code: 'timeout' },
    { state: 'unknown', code: 'timeout' },
  ]);

  // Rounds 1 and 2: try → unknown → pending (backoff) → forced due → try again.
  while (true) {
    await drainWorker(timeoutMock);
    const row = await jobRow(id);
    if (row.status !== 'pending') break;
    await makeJobDue(id);
  }
  const row = await jobRow(id);
  assert.equal(row.status, 'unknown');
  assert.equal(row.attempt, MAX_UNKNOWN_ATTEMPTS);
  assert.equal(timeoutMock.sendCount, 3, `exactly 3 tries, got ${timeoutMock.sendCount}`);

  // More ticks never resend the unknown job (no infinite resend).
  await makeJobDue(id);
  await drainWorker(timeoutMock);
  await makeJobDue(id);
  await drainWorker(timeoutMock);
  assert.equal(timeoutMock.sendCount, 3);
  const attempts = await attemptRows(id);
  assert.equal(attempts.length, 3);
  assert.ok(attempts.every((a) => a.state === 'unknown'));
});

// ---------------------------------------------------------------------------
// AC-43: 429 + Retry-After → due_at pushed per header, attempt++
// ---------------------------------------------------------------------------

test('AC-43: 429 with Retry-After pushes due_at beyond the header window', async () => {
  const u = await createUser('ob');
  await bindTelegram(u.accountId, '777000666');
  const { id } = await sql.begin((tx) => enqueueOutbox(tx, outboundJob(u.accountId, 'ob-429')));

  const mock = new MockTelegramTransport([{ state: 'unknown', code: 'rate_limited', retryAfterSeconds: 90 }]);
  await drainWorker(mock);

  const row = await jobRow(id);
  assert.equal(row.status, 'pending', '429 re-queues the job');
  assert.equal(row.attempt, 1, 'attempt++ on 429');
  const dueIn = new Date(row.due_at).getTime() - Date.now();
  assert.ok(dueIn > 80_000, `due_at must respect Retry-After=90s, got ${Math.round(dueIn / 1000)}s`);
  const attempts = await attemptRows(id);
  assert.equal(attempts[0]!.state, 'rate_limited');
});

// ---------------------------------------------------------------------------
// Lease mechanics: expired lease re-queues with attempt++
// ---------------------------------------------------------------------------

test('outbox: expired lease re-queues the job with attempt++', async () => {
  const u = await createUser('ob');
  await bindTelegram(u.accountId, '777000777');
  const { id } = await sql.begin((tx) => enqueueOutbox(tx, outboundJob(u.accountId, 'ob-lease')));
  // Simulate a crashed worker: job leased long ago, lease expired.
  await sql`
    UPDATE outbox_jobs SET status = 'leased', lease_until = now() - interval '1 second', attempt = 1
    WHERE id = ${id}
  `;
  const mock = new MockTelegramTransport();
  await drainWorker(mock);
  const first = await jobRow(id);
  assert.ok(['pending', 'sent'].includes(first.status), 'expired lease is re-queued or already delivered');
  if (first.status === 'pending') {
    // Re-queued with backoff → force due and drain again.
    assert.equal(first.attempt, 2, 'attempt++ on lease expiry (crashed try consumed)');
    await makeJobDue(id);
    await drainWorker(mock);
  }
  const final = await jobRow(id);
  assert.equal(final.status, 'sent', 're-queued job gets delivered by a later pass');
  // attempt++ at lease expiry (the crashed try) + attempt++ at the delivery
  // outcome → the delivered job carries attempt 3.
  assert.equal(final.attempt, 3, 'attempt counts the expired lease AND the delivery');
});

// ---------------------------------------------------------------------------
// applyOutcome guard: a non-leased job is never finalized (lease holder check)
// ---------------------------------------------------------------------------

test('applyOutcome: refuses to finalize a job that is no longer leased', async () => {
  const u = await createUser('ob');
  const { id } = await sql.begin((tx) => enqueueOutbox(tx, outboundJob(u.accountId, 'ob-guard')));
  const job = (await sql<OutboxJobRow[]>`SELECT * FROM outbox_jobs WHERE id = ${id}`)[0]!;
  await sql`UPDATE outbox_jobs SET status = 'suppressed' WHERE id = ${id}`;
  const status = await applyOutcome(sql, job, { state: 'sent', code: null, providerMessageId: 'x', retryAfterSeconds: null });
  assert.equal(status, 'suppressed', 'stale outcome must not overwrite the suppression');
});

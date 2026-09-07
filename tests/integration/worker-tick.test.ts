import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { GET as tickGET, POST as tickPOST } from '../../src/app/api/internal/worker-tick/route';
import { getSql, closeSql } from '../../src/lib/db';
import { enqueueOutbox } from '../../src/infra/outbox';
import { assertStatus, makeRequest } from './helpers';
import { bindTelegram, createUser, jobRow } from './phase3-helpers';

after(async () => {
  await closeSql();
});

const sql = getSql();
const SECRET = 'integration-worker-tick-secret';

// The integration runner leaves WORKER_TICK_SECRET unset (dev allowance is
// covered by its own test below); this suite pins a secret so the fail-closed
// 401s and all three secret carriers are exercised. Mock transport on: the
// route wires selectTransport() itself, which needs dev + TELEGRAM_MOCK=1.
process.env.WORKER_TICK_SECRET = SECRET;
process.env.TELEGRAM_MOCK = '1';

/** Enqueues one immediately-due outbound reply job for a bound chat. */
async function enqueueReply(accountId: string, chatId: string): Promise<string> {
  return sql.begin(async (tx) => {
    const { id } = await enqueueOutbox(tx, {
      dedupeKey: `tick-test:${randomUUID()}`,
      kind: 'telegram_reply',
      subjectId: null,
      channel: 'telegram',
      purpose: 'service_channel',
      payload: { account_id: accountId, chat_id: chatId, text: 'worker tick endpoint test' },
    });
    return id;
  });
}

// ---------------------------------------------------------------------------
// Auth gate: missing / wrong secret → 401 before any DB work
// ---------------------------------------------------------------------------

test('worker-tick: missing secret → 401 (fail-closed)', async () => {
  const res = await tickPOST(makeRequest('/api/internal/worker-tick', { method: 'POST' }));
  assertStatus(res, 401);
});

test('worker-tick: wrong secret on all three carriers → 401 (header, Bearer, query)', async () => {
  const wrong = 'definitely-not-the-secret';
  const byHeader = await tickPOST(
    makeRequest('/api/internal/worker-tick', { method: 'POST', headers: { 'x-worker-tick-secret': wrong } }),
  );
  assertStatus(byHeader, 401);
  const byBearer = await tickGET(
    makeRequest('/api/internal/worker-tick', {
      method: 'GET',
      headers: { authorization: `Bearer ${wrong}` },
    }),
  );
  assertStatus(byBearer, 401);
  const byQuery = await tickGET(makeRequest(`/api/internal/worker-tick?secret=${wrong}`, { method: 'GET' }));
  assertStatus(byQuery, 401);
});

test('worker-tick: fail-closed — production with unset secret → 401', async () => {
  const savedEnv = process.env.APP_ENV;
  const savedSecret = process.env.WORKER_TICK_SECRET;
  try {
    process.env.APP_ENV = 'production';
    delete process.env.WORKER_TICK_SECRET;
    const res = await tickPOST(makeRequest('/api/internal/worker-tick', { method: 'POST' }));
    assertStatus(res, 401);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, 'unauthorized_worker_tick');
  } finally {
    if (savedEnv === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = savedEnv;
    if (savedSecret === undefined) delete process.env.WORKER_TICK_SECRET;
    else process.env.WORKER_TICK_SECRET = savedSecret;
  }
});

// ---------------------------------------------------------------------------
// Happy paths: one shared secret across header / Bearer / query → one tick
// ---------------------------------------------------------------------------

test('worker-tick: correct secret via header → 200, queued job transitions to sent', async () => {
  const u = await createUser('tickhdr');
  const chatId = '991001';
  await bindTelegram(u.accountId, chatId);
  const jobId = await enqueueReply(u.accountId, chatId);

  const res = await tickPOST(
    makeRequest('/api/internal/worker-tick', { method: 'POST', headers: { 'x-worker-tick-secret': SECRET } }),
  );
  assertStatus(res, 200);
  const body = (await res.json()) as {
    ok: boolean;
    processed: number;
    requeued_leases: number;
    results: { job_id: string; kind: string; outcome: string }[];
  };
  assert.equal(body.ok, true);
  assert.ok(body.processed >= 1, 'at least our job was transitioned this tick');
  assert.ok(Array.isArray(body.results), 'per-job outcomes included');
  assert.ok(
    body.results.some((r) => r.job_id === jobId && r.kind === 'telegram_reply'),
    'our job id appears in the tick report',
  );

  const row = await jobRow(jobId);
  assert.equal(row.status, 'sent', 'mock transport accepted the reply');
});

test('worker-tick: correct secret via Authorization Bearer (Vercel cron style) → 200', async () => {
  const res = await tickGET(
    makeRequest('/api/internal/worker-tick', { method: 'GET', headers: { authorization: `Bearer ${SECRET}` } }),
  );
  assertStatus(res, 200);
  const body = (await res.json()) as { ok: boolean; processed: number };
  assert.equal(body.ok, true);
  assert.equal(typeof body.processed, 'number');
});

test('worker-tick: correct secret via ?secret= query fallback → 200', async () => {
  const res = await tickGET(makeRequest(`/api/internal/worker-tick?secret=${SECRET}`, { method: 'GET' }));
  assertStatus(res, 200);
  const body = (await res.json()) as { ok: boolean; processed: number };
  assert.equal(body.ok, true);
  assert.equal(typeof body.processed, 'number');
});

test('worker-tick: development with unset secret → 200 (documented local allowance)', async () => {
  delete process.env.WORKER_TICK_SECRET;
  try {
    const res = await tickPOST(makeRequest('/api/internal/worker-tick', { method: 'POST' }));
    assertStatus(res, 200);
    const body = (await res.json()) as { ok: boolean; processed: number };
    assert.equal(body.ok, true);
    assert.equal(typeof body.processed, 'number');
  } finally {
    process.env.WORKER_TICK_SECRET = SECRET;
  }
});

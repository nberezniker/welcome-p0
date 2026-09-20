import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { GET as health } from '../../src/app/api/health/route';
import { requeueExpiredLeases } from '../../src/infra/outbox';
import { makeRequest, assertStatus } from './helpers';
import { getSql, closeSql } from '../../src/lib/db';

/**
 * AC-56 — health when the WORKER is dead.
 *
 * The criterion (`GET /api/health`, spec 16 «safe DB write/rollback probe» plus
 * «queue/worker heartbeat») only means something if the two halves of the
 * payload stay independent:
 *
 *   - LIVENESS (`status`, `db`) answers "can this deployment serve?" — a dead
 *     worker must NOT turn it into a 503;
 *   - WORKER (`worker`) answers "is the outbox being drained?" — a dead worker
 *     must read `worker: 'down'`.
 *
 * The defect this suite was written against: the DB write probe in the health
 * route wrote `beat_at = now()` into `worker_heartbeat` — the very row read to
 * decide `worker`. Every health call therefore refreshed the signal it was
 * measuring, so `worker` could never be 'down' while the DB accepted writes, and
 * an uptime monitor pinging /api/health was itself keeping a dead worker looking
 * alive. README §3 step 5 promises the opposite ("`worker":"up"` requires a tick
 * within 60s"); the probe now writes only what cannot move the beat, and the
 * "probe does not forge" assertions below pin that down.
 *
 * The stalled-queue half of the criterion is what the two lag aggregates were
 * added for: with the worker dead nothing requeues expired leases and nothing
 * hands jobs over, so `pending_jobs` stops falling and
 * `oldest_pending_job_age_seconds` keeps growing.
 */

/** The route's own freshness window (src/app/api/health/route.ts: WORKER_FRESHNESS_SECONDS). */
const WORKER_FRESHNESS_SECONDS = 60;

after(async () => {
  await closeSql();
});

interface HealthBody {
  status: string;
  db: string;
  worker: string;
  pending_jobs: number;
  oldest_pending_job_age_seconds: number | null;
}

async function readHealth(): Promise<{ res: Response; status: number; body: HealthBody }> {
  const res = await health(makeRequest('/api/health'));
  const body = (await res.json()) as HealthBody;
  return { res, status: res.status, body };
}

/** The worker's own liveness signal, exactly as the route reads it. */
async function beatAt(): Promise<string | null> {
  const rows = await getSql()<{ beat_at: Date | null }[]>`
    SELECT beat_at FROM worker_heartbeat WHERE id = true
  `;
  return rows[0]?.beat_at ? new Date(rows[0]!.beat_at).toISOString() : null;
}

/** Age of the recorded beat, in seconds, or null when no beat was ever recorded. */
async function beatAgeSeconds(): Promise<number | null> {
  const rows = await getSql()<{ age: number | null }[]>`
    SELECT EXTRACT(EPOCH FROM now() - beat_at)::int AS age FROM worker_heartbeat WHERE id = true
  `;
  return rows[0]?.age ?? null;
}

async function setBeat(state: 'stale' | 'fresh' | 'never'): Promise<void> {
  const sql = getSql();
  if (state === 'stale') {
    await sql`
      INSERT INTO worker_heartbeat (id, beat_at) VALUES (true, now() - interval '10 minutes')
      ON CONFLICT (id) DO UPDATE SET beat_at = now() - interval '10 minutes'
    `;
    return;
  }
  if (state === 'fresh') {
    await sql`UPDATE worker_heartbeat SET beat_at = now() WHERE id = true`;
    return;
  }
  await sql`UPDATE worker_heartbeat SET beat_at = NULL WHERE id = true`;
}

test('AC-56: a dead worker does not fail liveness, and the health probe does not forge its beat', async () => {
  // The worker died ~10 minutes ago; the freshness window is 60s.
  await setBeat('stale');
  const age = await beatAgeSeconds();
  assert.ok(age !== null && age > WORKER_FRESHNESS_SECONDS, `simulated beat must be stale, got ${age}s`);
  const staleBeat = await beatAt();

  const { res, status, body } = await readHealth();

  // Liveness is independent of the worker: 200, status ok, db up.
  assertStatus(res, 200);
  assert.equal(status, 200, 'liveness must stay 200 with a dead worker');
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'up');

  // …and the dead worker is visible as such.
  assert.equal(body.worker, 'down', 'a beat older than the freshness window is down');

  // The regression guard: the DB write probe must not have moved the beat it
  // just read. If this fails, `worker` is unmeasurable — the probe refreshes its
  // own signal and no dead worker can ever be reported.
  assert.equal(
    await beatAt(),
    staleBeat,
    'the health probe forged the worker heartbeat — worker would always read up',
  );

  // A worker that DID tick reads up, so the verdict above discriminates rather
  // than being a constant.
  await setBeat('fresh');
  const live = await readHealth();
  assert.equal(live.status, 200);
  assert.equal(live.body.worker, 'up', 'a beat inside the window is up');
});

test('AC-56: never-ticked and never-seen workers read down without failing liveness', async () => {
  const sql = getSql();

  // Row present, no beat ever recorded.
  await setBeat('never');
  const neverTicked = await readHealth();
  assertStatus(neverTicked.res, 200);
  assert.equal(neverTicked.body.worker, 'down', 'no beat = no evidence of a worker');
  assert.equal(await beatAt(), null, 'a NULL beat stays NULL — the probe invents nothing');

  // No heartbeat row at all (a deployment whose worker never started). The write
  // probe must still prove write access by creating the row — but with no beat,
  // so the fresh row cannot be mistaken for a live worker.
  await sql`DELETE FROM worker_heartbeat`;
  const missing = await readHealth();
  assertStatus(missing.res, 200);
  assert.equal(missing.body.db, 'up', 'the write probe still writes (it recreated the missing row)');
  assert.equal(missing.body.worker, 'down', 'a worker that never ticked is not up');
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM worker_heartbeat WHERE id = true`;
  assert.equal(rows[0]!.n, 1, 'the write probe recreated the heartbeat row');
  assert.equal(await beatAt(), null, 'the row it created carries no beat');
});

test('AC-56: with the worker dead the queue stops draining and the lag fields say so truthfully', async () => {
  const sql = getSql();
  await setBeat('stale');

  // Two jobs a live worker should have moved, in the two shapes the metric counts
  // (non-terminal = pending + leased, spec 04 §7):
  //   - a pending job 7 minutes old (nothing handed it over);
  //   - a job whose lease expired 5 minutes ago — a live worker requeues expired
  //     leases on every tick (src/infra/outbox.ts), a dead one leaves it leased.
  const pendingId = randomUUID();
  await sql`
    INSERT INTO outbox_jobs (dedupe_key, kind, channel, purpose, payload, status, created_at)
    VALUES (${'ac56-pending:' + pendingId}, 'telegram_reply', 'telegram', 'service_channel', '{}'::jsonb,
            'pending', now() - interval '7 minutes')
  `;
  const leased = await sql<{ id: string }[]>`
    INSERT INTO outbox_jobs (dedupe_key, kind, channel, purpose, payload, status, lease_until, created_at)
    VALUES (${'ac56-leased:' + randomUUID()}, 'telegram_reply', 'telegram', 'service_channel', '{}'::jsonb,
            'leased', now() - interval '5 minutes', now() - interval '9 minutes')
    RETURNING id
  `;
  const leasedId = leased[0]!.id;

  const stalled = await readHealth();
  assertStatus(stalled.res, 200);
  assert.equal(stalled.status, 200, 'a stalled queue is not a liveness failure');
  assert.equal(stalled.body.worker, 'down');

  // The metric is about WORK and counts both non-terminal shapes: at least the
  // two seeded rows, aged at least as much as the older one (the queue in this
  // shared test DB is never empty, so "oldest" is a minimum by construction).
  assert.ok(stalled.body.pending_jobs >= 2, `both stalled jobs are counted, got ${stalled.body.pending_jobs}`);
  assert.ok(
    (stalled.body.oldest_pending_job_age_seconds ?? 0) >= 9 * 60,
    `the oldest non-terminal job is at least the 9-minute-old seed, got ${stalled.body.oldest_pending_job_age_seconds}s`,
  );
  // A count without an age (or an age without a count) would be a silent lie.
  assert.equal(stalled.body.oldest_pending_job_age_seconds === null, stalled.body.pending_jobs === 0);

  // Nothing requeued that expired lease — that IS the dead worker, and it is why
  // the row counts as lag instead of having gone back to `pending`.
  const stillLeased = await sql<{ status: string }[]>`SELECT status FROM outbox_jobs WHERE id = ${leasedId}`;
  assert.equal(stillLeased[0]?.status, 'leased', 'no worker ticked, so the expired lease is untouched');

  // The worker's own step, run once, proves the metric tracks a REAL stall rather
  // than a permanently counted row: the expired lease is requeued (still
  // non-terminal, so still lag — honestly) and the beat is refreshed by the
  // worker, which is what moves `worker` back to 'up'.
  const requeued = await requeueExpiredLeases(sql);
  await setBeat('fresh');
  const draining = await readHealth();
  assert.ok(requeued >= 1, 'the worker requeues expired leases');
  const afterRequeue = await sql<{ status: string }[]>`SELECT status FROM outbox_jobs WHERE id = ${leasedId}`;
  assert.equal(afterRequeue[0]?.status, 'pending', 'the requeued lease is pending again');
  assert.equal(draining.body.worker, 'up', 'a tick within the window is what makes a worker up');
  assert.equal(draining.status, 200);
});

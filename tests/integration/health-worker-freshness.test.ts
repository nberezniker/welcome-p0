import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { GET as health } from '../../src/app/api/health/route';
import { makeRequest, assertStatus } from './helpers';
import { getSql, closeSql } from '../../src/lib/db';
import { WORKER_FRESHNESS_SECONDS_DEFAULT, workerFreshnessSeconds } from '../../src/lib/env';

/**
 * The worker signal, made measurable and threshold-independent.
 *
 * `worker` is a single boolean answering a question whose window is a deployment
 * SETTING (`WORKER_FRESHNESS_SECONDS`): on this repo's serverless shape the only
 * unconditional tick source is a daily cron, so a 60-second window reported a
 * healthy worker as dead every day — and an operator reading the payload could
 * not tell "the scheduler ticks daily" from "the worker died", because the
 * payload carried the verdict and nothing else.
 *
 * Two things are pinned here:
 *
 *   1. `worker_last_tick_age_seconds` is the AGE itself (`null` when no tick was
 *      ever recorded, never a fabricated 0), so a monitor can threshold it
 *      without inheriting this deployment's cadence;
 *   2. the window is honoured as configured, and its DEFAULT is the cadence-shaped
 *      one — a beat an hour old is `up` by default (the false alarm is gone) and
 *      `down` with `WORKER_FRESHNESS_SECONDS=60` (the detection is not weakened,
 *      only retuned; the old constant is reachable by configuration).
 *
 * The rule the verdict uses is deliberately not relaxed anywhere in this file: a
 * beat older than the configured window is still down, and `tests/integration/
 * health-worker-dead.test.ts` keeps proving the probe cannot refresh the beat.
 */

after(async () => {
  await closeSql();
});

interface HealthBody {
  status: string;
  db: string;
  worker: string;
  worker_last_tick_age_seconds: number | null;
}

async function readHealth(): Promise<{ res: Response; body: HealthBody }> {
  const res = await health(makeRequest('/api/health'));
  const body = (await res.json()) as HealthBody;
  return { res, body };
}

/** Writes a real worker beat aged `ageSeconds`, or a NULL beat for "never ticked". */
async function setBeatAge(ageSeconds: number | null): Promise<void> {
  const sql = getSql();
  if (ageSeconds === null) {
    await sql`
      INSERT INTO worker_heartbeat (id, beat_at) VALUES (true, NULL)
      ON CONFLICT (id) DO UPDATE SET beat_at = NULL
    `;
    return;
  }
  await sql`
    INSERT INTO worker_heartbeat (id, beat_at)
    VALUES (true, now() - (${ageSeconds}::double precision * interval '1 second'))
    ON CONFLICT (id) DO UPDATE SET beat_at = now() - (${ageSeconds}::double precision * interval '1 second')
  `;
}

/** Age of the recorded beat in seconds, measured by the DATABASE — an
 *  independent clock, so agreement with the payload is real evidence. */
async function databaseBeatAgeSeconds(): Promise<number> {
  const rows = await getSql()<{ age: number }[]>`
    SELECT EXTRACT(EPOCH FROM now() - beat_at)::int AS age FROM worker_heartbeat WHERE id = true
  `;
  return rows[0]!.age;
}

test('worker age: a recent tick reports its age and reads up', async () => {
  await setBeatAge(5);
  const { res, body } = await readHealth();
  assertStatus(res, 200);
  assert.equal(body.worker, 'up');
  assert.equal(typeof body.worker_last_tick_age_seconds, 'number');
  assert.ok(
    body.worker_last_tick_age_seconds! >= 3 && body.worker_last_tick_age_seconds! < 60,
    `expected the ~5s seed, got ${body.worker_last_tick_age_seconds}s`,
  );
  // The published number is a measurement, not a decoration: the database's own
  // clock agrees with it (a fabricated 0/1 would fail this).
  const dbAge = await databaseBeatAgeSeconds();
  assert.ok(
    Math.abs(dbAge - body.worker_last_tick_age_seconds!) <= 2,
    `the reported age (${body.worker_last_tick_age_seconds}s) must match the beat the database holds (${dbAge}s)`,
  );
});

test('worker age: a stale tick reports the honest age while the boolean says down', async () => {
  const staleSeconds = 30 * 60 * 60;
  await setBeatAge(staleSeconds);
  const { res, body } = await readHealth();
  assertStatus(res, 200);
  assert.equal(body.worker, 'down', 'a beat older than the window is down');
  assert.ok(
    body.worker_last_tick_age_seconds! >= staleSeconds,
    `the age must show the real staleness, got ${body.worker_last_tick_age_seconds}s`,
  );
  assert.ok(
    body.worker_last_tick_age_seconds! > WORKER_FRESHNESS_SECONDS_DEFAULT,
    'the age is what lets a monitor see the verdict and the evidence side by side',
  );
});

test('worker age: no tick ever recorded is null — not zero, and it stays that way', async () => {
  await setBeatAge(null);
  const neverTicked = await readHealth();
  assertStatus(neverTicked.res, 200);
  assert.equal(neverTicked.body.worker, 'down');
  assert.equal(
    neverTicked.body.worker_last_tick_age_seconds,
    null,
    'no beat is not "a beat zero seconds ago"',
  );

  // No heartbeat row at all: the write probe recreates it (proving write access)
  // and still records no beat, so the age stays null rather than becoming a
  // fresh-looking number the probe invented.
  const sql = getSql();
  await sql`DELETE FROM worker_heartbeat`;
  const missingRow = await readHealth();
  assertStatus(missingRow.res, 200);
  assert.equal(missingRow.body.db, 'up');
  assert.equal(missingRow.body.worker_last_tick_age_seconds, null);
  const rows = await sql<{ beat_at: Date | null }[]>`SELECT beat_at FROM worker_heartbeat WHERE id = true`;
  assert.equal(rows[0]?.beat_at, null, 'the recreated row carries no beat');
});

test('default window: an hour-old beat is up — the window follows the cadence, not a minute', async () => {
  const oneHour = 60 * 60;
  // 60s — the previous hard-coded window — would call this a dead worker. On a
  // deployment whose only unconditional tick is a daily cron it is exactly the
  // healthy case, and reporting it down is what made the signal unusable.
  assert.ok(WORKER_FRESHNESS_SECONDS_DEFAULT > oneHour);
  await setBeatAge(oneHour);
  const { res, body } = await readHealth();
  assertStatus(res, 200);
  assert.equal(body.worker, 'up', 'the daily-cadence default must not flag an hour-old beat');
  assert.ok(
    body.worker_last_tick_age_seconds! >= oneHour - 60 && body.worker_last_tick_age_seconds! <= oneHour + 60,
    `expected ~${oneHour}s, got ${body.worker_last_tick_age_seconds}s`,
  );
});

test('WORKER_FRESHNESS_SECONDS retunes the verdict without touching the measurement', async () => {
  const oneHour = 60 * 60;
  await setBeatAge(oneHour);

  const saved = process.env.WORKER_FRESHNESS_SECONDS;
  try {
    process.env.WORKER_FRESHNESS_SECONDS = '60';
    assert.equal(workerFreshnessSeconds(), 60, 'the route reads the variable per request');
    const tuned = await readHealth();
    assertStatus(tuned.res, 200);
    assert.equal(tuned.body.worker, 'down', 'a 60s window must call an hour-old beat down');
    // The same beat, one field later: the verdict moved, the fact did not.
    assert.ok(
      tuned.body.worker_last_tick_age_seconds! >= oneHour - 60,
      'the age is unchanged by the threshold — only the boolean is',
    );

    delete process.env.WORKER_FRESHNESS_SECONDS;
    const restored = await readHealth();
    assertStatus(restored.res, 200);
    assert.equal(restored.body.worker, 'up', 'unsetting the override returns to the default window');
    assert.equal(
      restored.body.worker_last_tick_age_seconds,
      tuned.body.worker_last_tick_age_seconds,
      'a narrow window does not change how old the last tick is',
    );
  } finally {
    if (saved === undefined) delete process.env.WORKER_FRESHNESS_SECONDS;
    else process.env.WORKER_FRESHNESS_SECONDS = saved;
  }
});

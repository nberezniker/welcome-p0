import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { GET as health } from '../../src/app/api/health/route';
import { makeRequest, assertStatus } from './helpers';
import { getSql, closeSql } from '../../src/lib/db';

// F-16: the public health payload exposes {status, db, worker} + how old the last
// worker tick is + the two outbox lag aggregates and NOTHING else — the migration
// version (deployment fingerprint) requires the shared secret via the
// x-health-details header. The age and the lag numbers are timing of WORK, not
// identity: they say "the queue is not draining" and "the worker last ticked N
// seconds ago" without naming a job, a recipient or a build.

after(async () => {
  await closeSql();
});

test('F-16: public health payload has no migration details', async () => {
  const res = await health(makeRequest('/api/health'));
  assertStatus(res, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(body).sort(),
    ['db', 'oldest_pending_job_age_seconds', 'pending_jobs', 'status', 'worker', 'worker_last_tick_age_seconds'],
  );
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'up');
  assert.ok(body.worker === 'up' || body.worker === 'down');
  assert.ok(
    body.worker_last_tick_age_seconds === null || typeof body.worker_last_tick_age_seconds === 'number',
    'the worker age is a number, or null for "no tick ever recorded"',
  );
  assert.equal(body.migration_version, undefined);
  assert.equal(body.migrations, undefined);
});

// Delivery lag (health as a monitor, not just a liveness ping): the age of the
// OLDEST non-terminal outbox job, and how many there are. The queue in this
// shared test DB is never empty (other suites leave retry-scheduled jobs behind),
// so the assertion seeds a job with a known age and requires the metric to be at
// least that old — "oldest" is a minimum by construction, not an equality.
test('health: reports outbox delivery lag and counts only non-terminal jobs', async () => {
  const sql = getSql();
  const seeded = await sql<{ id: string }[]>`
    INSERT INTO outbox_jobs (dedupe_key, kind, channel, purpose, payload, status, created_at)
    VALUES (${'health-lag:' + randomUUID()}, 'telegram_reply', 'telegram', 'service_channel', '{}'::jsonb,
            'pending', now() - interval '5 minutes')
    RETURNING id
  `;

  const res = await health(makeRequest('/api/health'));
  assertStatus(res, 200);
  const body = (await res.json()) as {
    pending_jobs: number;
    oldest_pending_job_age_seconds: number | null;
  };
  assert.equal(typeof body.pending_jobs, 'number');
  assert.ok(body.pending_jobs >= 1, 'the seeded non-terminal job is counted');
  assert.ok(
    (body.oldest_pending_job_age_seconds ?? 0) >= 300,
    `the oldest non-terminal job is at least the seeded 5 minutes old, got ${body.oldest_pending_job_age_seconds}s`,
  );
  // The two fields cannot disagree: an empty queue has no age, a non-empty one
  // does. A null age next to a non-zero count would be a silent lie.
  assert.equal(body.oldest_pending_job_age_seconds === null, body.pending_jobs === 0);

  // …and it is the LIVE queue, not a history: a job that reaches a terminal
  // state leaves the count (and stops contributing its age).
  await sql`UPDATE outbox_jobs SET status = 'sent' WHERE id = ${seeded[0]!.id}`;
  const second = await health(makeRequest('/api/health'));
  assertStatus(second, 200);
  const after2 = (await second.json()) as { pending_jobs: number };
  assert.equal(after2.pending_jobs, body.pending_jobs - 1, 'a terminal job is no longer counted as lag');
});

test('F-16: x-health-details with the worker secret → full payload; wrong secret → public payload', async () => {
  const saved = process.env.WORKER_TICK_SECRET;
  process.env.WORKER_TICK_SECRET = 'f16-health-secret';
  try {
    const detailed = await health(
      makeRequest('/api/health', { headers: { 'x-health-details': 'f16-health-secret' } }),
    );
    assertStatus(detailed, 200);
    const body = (await detailed.json()) as Record<string, unknown>;
    assert.equal(body.migrations, 'applied');
    assert.match(String(body.migration_version), /^\d{3}$/);

    const wrong = await health(
      makeRequest('/api/health', { headers: { 'x-health-details': 'not-the-secret' } }),
    );
    assertStatus(wrong, 200);
    const wrongBody = (await wrong.json()) as Record<string, unknown>;
    assert.equal(wrongBody.migration_version, undefined);
  } finally {
    if (saved === undefined) delete process.env.WORKER_TICK_SECRET;
    else process.env.WORKER_TICK_SECRET = saved;
  }
});

// ---------------------------------------------------------------------------
// Build identity — the F-16 principle kept, with one explicit opt-in.
//
// A public endpoint should not fingerprint a deployment, so the identity is
// OFF by default and the default payload is asserted to be unchanged. The flag
// exists for the legitimate case (an internal monitor asking "which build
// answered?") without handing it WORKER_TICK_SECRET.
// ---------------------------------------------------------------------------

test('health: build identity is absent by default, whatever APP_BUILD_ID says', async () => {
  const env = process.env as unknown as Record<string, string | undefined>;
  const savedFlag = env.HEALTH_EXPOSE_VERSION;
  const savedBuild = env.APP_BUILD_ID;
  try {
    delete env.HEALTH_EXPOSE_VERSION;
    env.APP_BUILD_ID = 'sha-that-must-not-be-published';

    const res = await health(makeRequest('/api/health'));
    assertStatus(res, 200);
    const body = (await res.json()) as Record<string, unknown>;

    // The exact key set is the F-16 contract: no field may appear that a
    // deployment fingerprint could ride in on.
    assert.deepEqual(
      Object.keys(body).sort(),
      ['db', 'oldest_pending_job_age_seconds', 'pending_jobs', 'status', 'worker', 'worker_last_tick_age_seconds'],
    );
    // Absent, not null: a `build_id: null` would still be a behaviour change on
    // the live endpoint, and the live check (usage-matrix P1) asserts this shape.
    assert.equal('build_id' in body, false);
    assert.equal(JSON.stringify(body).includes('sha-that-must-not-be-published'), false);
  } finally {
    if (savedFlag === undefined) delete env.HEALTH_EXPOSE_VERSION;
    else env.HEALTH_EXPOSE_VERSION = savedFlag;
    if (savedBuild === undefined) delete env.APP_BUILD_ID;
    else env.APP_BUILD_ID = savedBuild;
  }
});

test('health: HEALTH_EXPOSE_VERSION=true publishes the build id — null when none is configured', async () => {
  const env = process.env as unknown as Record<string, string | undefined>;
  const savedFlag = env.HEALTH_EXPOSE_VERSION;
  const savedBuild = env.APP_BUILD_ID;
  try {
    env.HEALTH_EXPOSE_VERSION = 'true';

    // Configured → the operator's own value, verbatim.
    env.APP_BUILD_ID = 'gitsha-deadbeef1234';
    const withId = await health(makeRequest('/api/health'));
    assertStatus(withId, 200);
    const withIdBody = (await withId.json()) as Record<string, unknown>;
    assert.equal(withIdBody.build_id, 'gitsha-deadbeef1234');
    assert.deepEqual(
      Object.keys(withIdBody).sort(),
      ['build_id', 'db', 'oldest_pending_job_age_seconds', 'pending_jobs', 'status', 'worker', 'worker_last_tick_age_seconds'],
    );

    // Enabled but unset → null, which is a different fact from "no identity was
    // asked for" and must not be invented from the source tree or the host.
    delete env.APP_BUILD_ID;
    const noId = await health(makeRequest('/api/health'));
    assertStatus(noId, 200);
    const noIdBody = (await noId.json()) as Record<string, unknown>;
    assert.equal('build_id' in noIdBody, true);
    assert.equal(noIdBody.build_id, null);

    // Anything other than exactly 'true' is off: a flag must not be talked into
    // publishing by '1', 'yes' or 'TRUE'.
    for (const value of ['1', 'yes', 'TRUE', '']) {
      env.HEALTH_EXPOSE_VERSION = value;
      const res = await health(makeRequest('/api/health'));
      assertStatus(res, 200);
      assert.equal('build_id' in ((await res.json()) as Record<string, unknown>), false, `HEALTH_EXPOSE_VERSION=${JSON.stringify(value)} must stay off`);
    }
  } finally {
    if (savedFlag === undefined) delete env.HEALTH_EXPOSE_VERSION;
    else env.HEALTH_EXPOSE_VERSION = savedFlag;
    if (savedBuild === undefined) delete env.APP_BUILD_ID;
    else env.APP_BUILD_ID = savedBuild;
  }
});

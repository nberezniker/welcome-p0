import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { GET as health } from '../../src/app/api/health/route';
import { makeRequest, assertStatus } from './helpers';
import { closeSql } from '../../src/lib/db';

// F-16: the public health payload exposes {status, db, worker} ONLY — the
// migration version (deployment fingerprint) requires the shared secret via
// the x-health-details header.

after(async () => {
  await closeSql();
});

test('F-16: public health payload has no migration details', async () => {
  const res = await health(makeRequest('/api/health'));
  assertStatus(res, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['db', 'status', 'worker']);
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'up');
  assert.ok(body.worker === 'up' || body.worker === 'down');
  assert.equal(body.migration_version, undefined);
  assert.equal(body.migrations, undefined);
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

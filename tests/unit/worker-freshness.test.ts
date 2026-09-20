import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORKER_FRESHNESS_SECONDS_DEFAULT, workerFreshnessSeconds } from '../../src/lib/env';

/**
 * The worker-heartbeat freshness window — the number GET /api/health judges
 * `worker` by.
 *
 * A window is only meaningful relative to the TICK CADENCE of the deployment it
 * runs in, and the two failure modes are opposite halves of the same mistake:
 *
 *   - too SHORT (the bug this setting was introduced for): a healthy worker is
 *     reported `down` forever on a deployment whose only tick source is a daily
 *     cron, and an uptime monitor learns to ignore the field;
 *   - too LONG or non-positive-by-accident: `worker` stops discriminating, or
 *     reads `down` on every deployment — the first case again by another route.
 *
 * So the assertions below are about the two properties that make the default
 * defensible (it must exceed one tick period and stay below two) and about the
 * parser refusing to be talked into either failure mode by a bad value.
 */

test('worker freshness: unset or empty falls back to the default', () => {
  assert.equal(workerFreshnessSeconds(undefined), WORKER_FRESHNESS_SECONDS_DEFAULT);
  // `.env.example` ships the name with an EMPTY value, and a self-hoster who
  // leaves it blank must get the default — not 0, which would read as "every
  // beat is stale".
  assert.equal(workerFreshnessSeconds(''), WORKER_FRESHNESS_SECONDS_DEFAULT);
});

test('worker freshness: the default is shaped to a daily tick cadence', () => {
  const daySeconds = 24 * 60 * 60;
  // One full period of the deployment's unconditional tick source (the daily
  // Vercel cron) — below this, a healthy worker reads down for part of every day.
  assert.ok(
    WORKER_FRESHNESS_SECONDS_DEFAULT > daySeconds,
    `default must exceed one daily cron period, got ${WORKER_FRESHNESS_SECONDS_DEFAULT}s`,
  );
  // …and below two, so a worker that misses a whole day is still reported down
  // (at a 48h+ window the check would tolerate one entire missed tick).
  assert.ok(
    WORKER_FRESHNESS_SECONDS_DEFAULT < 2 * daySeconds,
    `default must stay under two cron periods, got ${WORKER_FRESHNESS_SECONDS_DEFAULT}s`,
  );
  assert.equal(WORKER_FRESHNESS_SECONDS_DEFAULT, 26 * 60 * 60, '24h cadence + 2h of cron dispatch slack');
});

test('worker freshness: an explicit window is honoured as written', () => {
  // The documented self-hosting values: the 2s worker loop, a per-minute cron,
  // the 5-minute pinger — plus a whole day.
  for (const value of ['120', '180', '900', '86400', '1']) {
    assert.equal(workerFreshnessSeconds(value), Number(value), `override ${value}s`);
  }
});

test('worker freshness: values that would break the signal fall back to the default', () => {
  const bad = ['0', '-1', '-60', '7.5', '60s', 'nonsense', '', 'NaN', 'Infinity'];
  for (const value of bad) {
    assert.equal(
      workerFreshnessSeconds(value),
      WORKER_FRESHNESS_SECONDS_DEFAULT,
      `${JSON.stringify(value)} must not replace the window`,
    );
  }
});

test('worker freshness: a seconds/milliseconds mix-up stays detectable', () => {
  // 26h expressed in milliseconds. Taken literally it would disable the check
  // for ~3 years, so it is refused — and the fallback is exactly the value that
  // mistake was reaching for, which is why the default is a safe landing place.
  assert.equal(workerFreshnessSeconds('93600000'), WORKER_FRESHNESS_SECONDS_DEFAULT);
});

test('worker freshness: the upper bound is 30 days, and nothing above it is used', () => {
  const max = 30 * 24 * 60 * 60;
  assert.equal(workerFreshnessSeconds(String(max)), max, 'the bound itself is a legal window');
  assert.equal(workerFreshnessSeconds(String(max + 1)), WORKER_FRESHNESS_SECONDS_DEFAULT);
});

test('worker freshness: the variable is read per call, so a change needs no restart', () => {
  const saved = process.env.WORKER_FRESHNESS_SECONDS;
  try {
    // No argument → the process env is the source (the route calls it that way,
    // so a deployment can change cadence and the very next health call honours it).
    process.env.WORKER_FRESHNESS_SECONDS = '900';
    assert.equal(workerFreshnessSeconds(), 900);
    delete process.env.WORKER_FRESHNESS_SECONDS;
    assert.equal(workerFreshnessSeconds(), WORKER_FRESHNESS_SECONDS_DEFAULT);
  } finally {
    if (saved === undefined) delete process.env.WORKER_FRESHNESS_SECONDS;
    else process.env.WORKER_FRESHNESS_SECONDS = saved;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoffMs, MAX_UNKNOWN_ATTEMPTS } from '../../src/infra/outbox';

// ---------------------------------------------------------------------------
// Backoff calc (attempt² * 5s + jitter)
// ---------------------------------------------------------------------------

test('backoff: attempt 1 with zero jitter is exactly 5s', () => {
  assert.equal(computeBackoffMs(1, () => 0), 5000);
});

test('backoff: attempt 3 with zero jitter is 45s', () => {
  assert.equal(computeBackoffMs(3, () => 0), 45_000);
});

test('backoff: jitter stays within 0..2.5s', () => {
  assert.equal(computeBackoffMs(1, () => 1), 7500);
  assert.equal(computeBackoffMs(2, () => 0.5), 20_000 + 1250);
});

test('backoff: non-positive attempt clamps to 1', () => {
  assert.equal(computeBackoffMs(0, () => 0), 5000);
  assert.equal(computeBackoffMs(-5, () => 0), 5000);
});

test('backoff: grows monotonically with attempt number', () => {
  let prev = -1;
  for (let a = 1; a <= 6; a++) {
    const ms = computeBackoffMs(a, () => 0);
    assert.ok(ms > prev, `attempt ${a} must back off more than ${a - 1}`);
    prev = ms;
  }
});

test('unknown cap: exactly 3 tries before terminal unknown (AC-42 contract)', () => {
  assert.equal(MAX_UNKNOWN_ATTEMPTS, 3);
});

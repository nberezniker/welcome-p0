import test from 'node:test';
import assert from 'node:assert/strict';
import {
  takeFromBucket,
  consumeIpToken,
  setRateLimitClock,
  resetIpBuckets,
} from '../../src/lib/ratelimit';

const OPTS = { capacity: 3, windowMs: 60_000 };

test('takeFromBucket: a fresh bucket starts full and drains one token per take', () => {
  let state = undefined as undefined | { tokens: number; lastRefillMs: number };
  const now = 1_000;

  const first = takeFromBucket(state, now, OPTS);
  assert.equal(first.allowed, true);
  assert.equal(first.remaining, 2); // capacity 3, one consumed
  state = first.state;

  const second = takeFromBucket(state, now, OPTS);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 1);
  state = second.state;

  const third = takeFromBucket(state, now, OPTS);
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  state = third.state;

  const fourth = takeFromBucket(state, now, OPTS);
  assert.equal(fourth.allowed, false);
  assert.equal(fourth.remaining, 0);
  assert.ok(fourth.retryAfterMs > 0, 'denied take must carry a retry-after');
});

test('takeFromBucket: tokens refill linearly with the injected clock', () => {
  // rate = 3/60000 = one token per 20s
  let state = { tokens: 0, lastRefillMs: 0 };
  const step = (ms: number) => {
    const r = takeFromBucket(state, ms, OPTS);
    state = r.state;
    return r;
  };
  assert.equal(step(10_000).allowed, false); // 0.5 tokens — not enough
  assert.equal(step(19_999).allowed, false); // 0.99995 — still short
  assert.equal(step(20_000).allowed, true); // exactly 1.0
  assert.equal(step(20_000).allowed, false); // empty again, no time passed
  assert.equal(step(80_000).allowed, true); // a full window refills to capacity 3
  assert.equal(state.tokens, 2);
});

test('takeFromBucket: refill never exceeds capacity', () => {
  const state = { tokens: 0.5, lastRefillMs: 0 };
  const res = takeFromBucket(state, 10_000_000, OPTS);
  assert.equal(res.allowed, true);
  assert.equal(res.state.tokens, OPTS.capacity - 1); // capped at capacity, then one consumed
});

test('consumeIpToken: same ip+route drains, other routes and ips are isolated', () => {
  resetIpBuckets();
  let now = 500_000;
  setRateLimitClock(() => now);

  for (let i = 0; i < 3; i++) {
    const v = consumeIpToken('10.0.0.1', 'otp_request', OPTS);
    assert.equal(v.allowed, true);
  }
  assert.equal(consumeIpToken('10.0.0.1', 'otp_request', OPTS).allowed, false);

  // different route → own bucket
  assert.equal(consumeIpToken('10.0.0.1', 'reports', OPTS).allowed, true);
  // different ip → own bucket
  assert.equal(consumeIpToken('10.0.0.2', 'otp_request', OPTS).allowed, true);

  // time moves past the window → refilled from empty, capped at capacity
  now += OPTS.windowMs * 10;
  const v = consumeIpToken('10.0.0.1', 'otp_request', OPTS);
  assert.equal(v.allowed, true);
  assert.equal(v.remaining, OPTS.capacity - 1);

  resetIpBuckets();
  setRateLimitClock(() => Date.now());
});

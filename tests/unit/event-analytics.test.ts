import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversionPercent, funnelSteps, type EventAnalytics } from '../../src/domain/event-analytics';

/** Funnel presentation is pure arithmetic; the SQL aggregates are covered by the
 * integration suite. These tests pin the EDGE behaviour the UI depends on. */

function analytics(over: Partial<EventAnalytics> = {}): EventAnalytics {
  return {
    registrations_total: 0,
    registrations_claimed: 0,
    members_active: 0,
    members_directory_visible: 0,
    intros_requested: 0,
    intros_mutual: 0,
    intros_declined: 0,
    reveals_total: 0,
    notes_created: 0,
    attendance_self_reported: 0,
    by_day: [],
    ...over,
  };
}

test('conversionPercent: rounds to the nearest integer and clamps to 0..100', () => {
  assert.equal(conversionPercent(1, 2), 50);
  assert.equal(conversionPercent(1, 3), 33);
  assert.equal(conversionPercent(2, 3), 67);
  assert.equal(conversionPercent(3, 3), 100);
  assert.equal(conversionPercent(0, 5), 0);
  // More activations than registrations is possible (direct joins) — never >100%.
  assert.equal(conversionPercent(7, 5), 100);
});

test('conversionPercent: a zero previous step has no percentage at all', () => {
  // 0 → 3 must not read as 0% ("nobody") or 100% ("everyone"): the UI shows a dash.
  assert.equal(conversionPercent(3, 0), null);
  assert.equal(conversionPercent(0, 0), null);
  assert.equal(conversionPercent(-1, 0), null);
  assert.equal(conversionPercent(Number.NaN, 10), null);
  assert.equal(conversionPercent(1, Number.POSITIVE_INFINITY), null);
});

test('funnelSteps: chains the five steps and shares each against its predecessor', () => {
  const steps = funnelSteps(
    analytics({
      registrations_total: 10,
      members_active: 5,
      members_directory_visible: 4,
      intros_requested: 2,
      intros_mutual: 1,
    }),
  );
  assert.deepEqual(steps.map((s) => s.key), ['registrations', 'activated', 'directory', 'intros', 'mutual']);
  assert.deepEqual(steps.map((s) => s.value), [10, 5, 4, 2, 1]);
  // The first step has no predecessor to compare against.
  assert.equal(steps[0]!.shareOfPrevious, null);
  assert.deepEqual(steps.slice(1).map((s) => s.shareOfPrevious), [50, 80, 50, 50]);
});

test('funnelSteps: shares survive an empty event', () => {
  const steps = funnelSteps(analytics());
  assert.deepEqual(steps.map((s) => s.value), [0, 0, 0, 0, 0]);
  assert.deepEqual(steps.map((s) => s.shareOfPrevious), [null, null, null, null, null]);
});

test('funnelSteps: a step larger than the previous one still reports a bounded share', () => {
  // Direct joins (no import) make activation exceed registrations; that must not
  // produce a >100% conversion.
  const steps = funnelSteps(analytics({ registrations_total: 1, members_active: 4 }));
  assert.equal(steps[1]!.shareOfPrevious, 100);
});

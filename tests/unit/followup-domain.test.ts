import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  followupReminderDedupeKey,
  isOptedIn,
  isRemindableStatus,
  renderReminderMessage,
  selectDueReminders,
  unsubscribePath,
  unsubscribeToken,
  verifyUnsubscribeToken,
  type FollowupNoteInput,
} from '../../src/domain/followup';
import { FOLLOWUP_REMINDER_DAYS_DEFAULT, digestEnabled, followupReminderDays, followupRemindersEnabled } from '../../src/lib/env';

/**
 * «Next step» reminder — the pure rules (design §B5, Phase 4).
 *
 * These tests exist to make the four promises of the mechanic mechanical rather
 * than aspirational: only the author is addressed, only a MEETING produces a
 * reminder, done/dropped are terminal, and one reminder per note per state
 * transition. The copy assertions are the spec-§7 half: the body carries the
 * recipient's own data and nothing that could read as an invented outcome.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0); // 2026-09-15T12:00:00Z

function note(over: Partial<FollowupNoteInput> = {}): FollowupNoteInput {
  return {
    ownerAccountId: 'acc-1',
    otherProfileId: 'prof-1',
    otherDisplayName: 'Anna K.',
    nextStep: 'Send the pilot proposal',
    nextStepStatus: 'confirmed',
    stepSetAtMs: NOW - 8 * DAY,
    introductionMutual: true,
    remindedStatus: null,
    ...over,
  };
}

const OPTS = { nowMs: NOW, days: FOLLOWUP_REMINDER_DAYS_DEFAULT };

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test('reminder: a step set 8 days ago after a mutual introduction is due', () => {
  const due = selectDueReminders([note()], OPTS);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.ownerAccountId, 'acc-1');
  assert.equal(due[0]!.otherProfileId, 'prof-1');
  assert.equal(due[0]!.status, 'confirmed');
  assert.equal(due[0]!.nextStep, 'Send the pilot proposal');
  assert.equal(due[0]!.dedupeKey, 'followup:acc-1:prof-1:confirmed');
});

test('reminder: never for an introduction that did not become mutual', () => {
  // pending / declined / revoked / closed all arrive here as `false` — the design
  // forbids claiming contacts were exchanged without BOTH sides agreeing.
  assert.deepEqual(selectDueReminders([note({ introductionMutual: false })], OPTS), []);
});

test('reminder: done and dropped are terminal, `none` is not a commitment', () => {
  for (const status of ['done', 'dropped', 'none']) {
    assert.deepEqual(selectDueReminders([note({ nextStepStatus: status })], OPTS), [], `status=${status}`);
  }
  assert.deepEqual(selectDueReminders([note({ nextStepStatus: 'proposed' })], OPTS).length, 1);
});

test('reminder: the delay is respected to the millisecond', () => {
  const exactly = note({ stepSetAtMs: NOW - 7 * DAY });
  const justUnder = note({ stepSetAtMs: NOW - 7 * DAY + 1 });
  assert.equal(selectDueReminders([exactly], OPTS).length, 1, 'exactly N days is due');
  assert.deepEqual(selectDueReminders([justUnder], OPTS), [], 'one ms short is not due');
});

test('reminder: an empty or missing step is never a reminder', () => {
  assert.deepEqual(selectDueReminders([note({ nextStep: null })], OPTS), []);
  assert.deepEqual(selectDueReminders([note({ nextStep: '   ' })], OPTS), []);
});

test('reminder: an unparsable timestamp fails closed instead of firing immediately', () => {
  assert.deepEqual(selectDueReminders([note({ stepSetAtMs: Number.NaN })], OPTS), []);
  assert.deepEqual(selectDueReminders([note({ stepSetAtMs: 0 })], OPTS), []);
});

test('reminder: one reminder per note per state transition', () => {
  assert.deepEqual(selectDueReminders([note({ remindedStatus: 'confirmed' })], OPTS), []);
  // A note that moved on to another status IS due again — the transition is new.
  assert.equal(selectDueReminders([note({ remindedStatus: 'proposed' })], OPTS).length, 1);
});

test('reminder: dedupe keys are stable, unique per note and per status', () => {
  assert.equal(
    followupReminderDedupeKey('acc-1', 'prof-1', 'confirmed'),
    followupReminderDedupeKey('acc-1', 'prof-1', 'confirmed'),
  );
  assert.notEqual(
    followupReminderDedupeKey('acc-1', 'prof-1', 'confirmed'),
    followupReminderDedupeKey('acc-1', 'prof-1', 'proposed'),
  );
  assert.notEqual(
    followupReminderDedupeKey('acc-1', 'prof-1', 'confirmed'),
    followupReminderDedupeKey('acc-2', 'prof-1', 'confirmed'),
  );
});

test('reminder: the selection is deterministic and sorted by author', () => {
  const input = [
    note({ ownerAccountId: 'b', otherProfileId: 'p2' }),
    note({ ownerAccountId: 'a', otherProfileId: 'p9' }),
    note({ ownerAccountId: 'a', otherProfileId: 'p1' }),
  ];
  const first = selectDueReminders(input, OPTS).map((r) => `${r.ownerAccountId}/${r.otherProfileId}`);
  const again = selectDueReminders([...input].reverse(), OPTS).map((r) => `${r.ownerAccountId}/${r.otherProfileId}`);
  assert.deepEqual(first, ['a/p1', 'a/p9', 'b/p2']);
  assert.deepEqual(again, first, 'input order must not change the output order');
});

test('reminder: one note yields one recipient — its own author', () => {
  const due = selectDueReminders([note()], OPTS);
  assert.equal(due[0]!.ownerAccountId, 'acc-1');
  // The counterparty is named in the BODY, never in the recipient field.
  assert.notEqual(due[0]!.ownerAccountId, due[0]!.otherProfileId);
});

test('reminder: days come from env, defaulting to 7 and refusing nonsense', () => {
  assert.equal(followupReminderDays(undefined), FOLLOWUP_REMINDER_DAYS_DEFAULT);
  assert.equal(followupReminderDays('14'), 14);
  assert.equal(followupReminderDays('0'), FOLLOWUP_REMINDER_DAYS_DEFAULT, 'zero must not mean "right now"');
  assert.equal(followupReminderDays('-5'), FOLLOWUP_REMINDER_DAYS_DEFAULT);
  assert.equal(followupReminderDays('7.5'), FOLLOWUP_REMINDER_DAYS_DEFAULT);
  assert.equal(followupReminderDays('nonsense'), FOLLOWUP_REMINDER_DAYS_DEFAULT);
  assert.equal(followupReminderDays('100000'), FOLLOWUP_REMINDER_DAYS_DEFAULT);
});

test('reminder: status allow-list is exactly proposed|confirmed', () => {
  assert.equal(isRemindableStatus('proposed'), true);
  assert.equal(isRemindableStatus('confirmed'), true);
  for (const bad of ['none', 'done', 'dropped', 'DONE', '', null, 7]) {
    assert.equal(isRemindableStatus(bad), false, `isRemindableStatus(${String(bad)})`);
  }
});

// ---------------------------------------------------------------------------
// Feature flags — "absent/false ⇒ the feature does not exist"
// ---------------------------------------------------------------------------

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('flags: only the exact string "true" turns a mechanic on', () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, false],
    ['', false],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['yes', false],
    ['TRUE', false],
    [' true', false],
    ['true', true],
  ];
  for (const [value, expected] of cases) {
    withEnv({ FOLLOWUP_REMINDERS_ENABLED: value }, () => {
      assert.equal(followupRemindersEnabled(), expected, `reminders flag=${JSON.stringify(value)}`);
    });
    withEnv({ DIGEST_ENABLED: value }, () => {
      assert.equal(digestEnabled(), expected, `digest flag=${JSON.stringify(value)}`);
    });
  }
});

test('flags: the two mechanics are independent switches', () => {
  withEnv({ FOLLOWUP_REMINDERS_ENABLED: 'true', DIGEST_ENABLED: undefined }, () => {
    assert.equal(followupRemindersEnabled(), true);
    assert.equal(digestEnabled(), false, 'one flag must never turn the other mechanic on');
  });
});

test('flags: the value is read per call, never captured at module load', () => {
  withEnv({ DIGEST_ENABLED: undefined }, () => assert.equal(digestEnabled(), false));
  withEnv({ DIGEST_ENABLED: 'true' }, () => assert.equal(digestEnabled(), true));
  withEnv({ DIGEST_ENABLED: undefined }, () => assert.equal(digestEnabled(), false, 'turning it back off must be honoured'));
});

// ---------------------------------------------------------------------------
// Opt-in bookkeeping
// ---------------------------------------------------------------------------

test('opt-in: absent, out-of-order and re-opt-in are all read correctly', () => {
  const t1 = new Date('2026-09-01T10:00:00Z');
  const t2 = new Date('2026-09-10T10:00:00Z');
  assert.equal(isOptedIn(null, null), false, 'never asked = off (the default for every account)');
  assert.equal(isOptedIn(t1, null), true);
  assert.equal(isOptedIn(t1, t2), false, 'opt-out after opt-in wins');
  assert.equal(isOptedIn(t2, t1), true, 're-opting in after an opt-out works');
  assert.equal(isOptedIn(null, t1), false, 'an opt-out without an opt-in is still off');
});

// ---------------------------------------------------------------------------
// Copy (spec §7)
// ---------------------------------------------------------------------------

test('reminder copy: carries the author’s own step and a stop link, nothing else', () => {
  const message = renderReminderMessage({
    locale: 'en',
    counterpartyName: 'Anna K.',
    nextStep: 'Send the pilot proposal',
    link: 'https://welcome.test/me/notes',
    unsubscribeLink: 'https://welcome.test/api/me/followup/unsubscribe?t=abc',
  });
  assert.match(message.subject, /next step/i);
  assert.match(message.text, /Send the pilot proposal/);
  assert.match(message.text, /Anna K\./);
  assert.match(message.text, /https:\/\/welcome\.test\/me\/notes/);
  assert.match(message.text, /unsubscribe\?t=abc/);
  // No promise about what will happen, no invented outcome, no statistic.
  for (const forbidden of [/\d+%/, /guarantee/i, /will find/i, /success/i, /contacts were exchanged/i]) {
    assert.doesNotMatch(message.text, forbidden);
  }
});

test('reminder copy: whitespace and length are flattened, never multi-line injected', () => {
  const message = renderReminderMessage({
    locale: 'en',
    counterpartyName: 'Anna\nK.',
    nextStep: `Send it\n\nSecond line ${'x'.repeat(400)}`,
    link: 'L',
    unsubscribeLink: 'U',
  });
  assert.doesNotMatch(message.text, /Send it\n\nSecond/, 'the step is collapsed to one line');
  assert.ok(message.text.length < 1200, 'bounded body');
  assert.doesNotMatch(message.text, /Anna\nK\./);
});

test('reminder copy: every locale renders without leaving placeholders behind', () => {
  for (const locale of ['en', 'ru', 'es'] as const) {
    const message = renderReminderMessage({
      locale,
      counterpartyName: 'Anna',
      nextStep: 'Step',
      link: 'L',
      unsubscribeLink: 'U',
    });
    assert.doesNotMatch(message.text, /\{[a-z]+\}/i, `${locale} left a placeholder`);
    assert.ok(message.subject.length > 0, `${locale} has a subject`);
  }
});

test('reminder copy: an empty name degrades to a dash, never to a dangling sentence', () => {
  const message = renderReminderMessage({ locale: 'en', counterpartyName: '  ', nextStep: 'X', link: 'L', unsubscribeLink: 'U' });
  assert.match(message.text, /meeting —/);
});

// ---------------------------------------------------------------------------
// One-click unsubscribe token
// ---------------------------------------------------------------------------

const PEPPER = 'unit-test-pepper-0123456789abcdef';

test('unsubscribe token: round-trips, and the mechanic is part of the signature', () => {
  const token = unsubscribeToken('11111111-2222-3333-4444-555555555555', 'digest', PEPPER);
  assert.deepEqual(verifyUnsubscribeToken(token, PEPPER), {
    accountId: '11111111-2222-3333-4444-555555555555',
    mechanic: 'digest',
  });
  // Swapping the mechanic in the clear part must not verify: the signature covers it.
  const forged = token.replace(/^digest\./, 'reminders.');
  assert.equal(verifyUnsubscribeToken(forged, PEPPER), null);
});

test('unsubscribe token: a different pepper, a truncated token or junk never verifies', () => {
  const accountId = '11111111-2222-3333-4444-555555555555';
  const token = unsubscribeToken(accountId, 'reminders', PEPPER);
  assert.equal(verifyUnsubscribeToken(token, 'another-pepper-0123456789abcdef'), null);
  assert.equal(verifyUnsubscribeToken(token.slice(0, -2), PEPPER), null);
  assert.equal(verifyUnsubscribeToken(`${token}0`, PEPPER), null);
  assert.equal(verifyUnsubscribeToken('reminders.not-a-uuid.deadbeef', PEPPER), null);
  assert.equal(verifyUnsubscribeToken('other.' + accountId + '.deadbeef', PEPPER), null);
  assert.equal(verifyUnsubscribeToken('', PEPPER), null);
  assert.equal(verifyUnsubscribeToken(null, PEPPER), null);
});

test('unsubscribe path: the link carries only the token — no address, no session', () => {
  const path = unsubscribePath('11111111-2222-3333-4444-555555555555', 'digest', PEPPER);
  assert.match(path, /^\/api\/me\/followup\/unsubscribe\?t=digest\./);
  assert.doesNotMatch(path, /@/);
  assert.equal(path.split('&').length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOALS,
  GOAL_IDS,
  MAX_GOALS,
  goalById,
  goalLabel,
  goalsPayload,
  isGoalId,
  validateGoals,
} from '../../src/domain/goals';
import { INTEREST_IDS, INTENT_IDS } from '../../src/domain/taxonomy';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/** Goals catalogue + validation (matching v4 §B2, private by design). */

/** The 16 goals of the design doc, verbatim. */
const EXPECTED_IDS = [
  'learn-skill',
  'find-mentor',
  'become-mentor',
  'find-cofounder',
  'hire',
  'get-hired',
  'find-clients',
  'get-more-clients',
  'enter-market',
  'fundraise',
  'invest',
  'find-partners',
  'find-community',
  'get-feedback',
  'give-feedback',
  'grow-network',
];

test('goals: the catalogue is exactly the 16 design goals, in doc order', () => {
  assert.deepEqual([...GOAL_IDS], EXPECTED_IDS);
  assert.equal(MAX_GOALS, 3);
});

test('goals: every goal has a label in all three locales', () => {
  for (const goal of GOALS) {
    for (const locale of ['ru', 'en', 'es'] as const) {
      const label = goal.label[locale];
      assert.equal(typeof label, 'string', `${goal.id}.${locale}`);
      assert.ok(label.trim().length > 0, `${goal.id}.${locale} must not be blank`);
    }
    assert.equal(new Set(Object.values(goal.label)).size, 3, `${goal.id}: labels must differ per locale`);
  }
});

test('goals: patterns reference real catalogue ids only', () => {
  const intents = new Set(INTENT_IDS);
  const interests = new Set(INTEREST_IDS);
  for (const goal of GOALS) {
    for (const id of goal.pattern.candidateOffers) {
      assert.ok(intents.has(id), `${goal.id}: unknown offer intent ${id}`);
    }
    for (const id of goal.pattern.candidateNeeds) {
      assert.ok(intents.has(id), `${goal.id}: unknown need intent ${id}`);
    }
    for (const id of goal.pattern.interests) {
      assert.ok(interests.has(id), `${goal.id}: unknown interest ${id}`);
    }
  }
  // Exactly one goal is deliberately pattern-less: "grow my network" is served
  // by anyone (it is what the whole product does).
  const broad = GOALS.filter((g) => g.pattern.broad === true).map((g) => g.id);
  assert.deepEqual(broad, ['grow-network']);
  for (const goal of GOALS) {
    if (goal.pattern.broad) continue;
    const total =
      goal.pattern.candidateOffers.length + goal.pattern.candidateNeeds.length + goal.pattern.interests.length;
    assert.ok(total > 0, `${goal.id}: a non-broad goal needs at least one pattern`);
  }
});

test('goals: lookup helpers reject unknown ids instead of guessing', () => {
  assert.equal(isGoalId('find-mentor'), true);
  assert.equal(isGoalId('mentor'), false);
  assert.equal(isGoalId(42), false);
  assert.equal(goalById('find-mentor')?.label.en, 'Find a mentor');
  assert.equal(goalById('nope'), null);
  assert.equal(goalLabel('find-mentor', 'ru'), 'Найти ментора');
  assert.equal(goalLabel('nope', 'ru'), null);
});

test('goals: validateGoals keeps the user priority order and dedupes in place', () => {
  assert.deepEqual(validateGoals(['fundraise', 'hire', 'find-mentor']), {
    ok: true,
    value: ['fundraise', 'hire', 'find-mentor'],
  });
  // A duplicate collapses to its FIRST position — re-picking never promotes.
  assert.deepEqual(validateGoals(['hire', 'fundraise', 'hire']), { ok: true, value: ['hire', 'fundraise'] });
  // Absent/null = "no goals" (and clears a stored list), never an error.
  assert.deepEqual(validateGoals(undefined), { ok: true, value: [] });
  assert.deepEqual(validateGoals(null), { ok: true, value: [] });
  assert.deepEqual(validateGoals([]), { ok: true, value: [] });
});

test('goals: validateGoals rejects a fourth goal and unknown ids', () => {
  const tooMany = validateGoals(['fundraise', 'hire', 'find-mentor', 'invest']);
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.ok === false && tooMany.code, 'invalid_goals');
  assert.match(tooMany.ok === false ? tooMany.message : '', /at most 3/);

  const unknown = validateGoals(['fundraise', 'be-a-unicorn']);
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok === false ? unknown.message : '', /Unknown goal "be-a-unicorn"/);

  for (const bad of ['fundraise', 42, {}]) {
    const res = validateGoals(bad);
    assert.equal(res.ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('goals: the payload carries ids and labels only — never the matching patterns', () => {
  const payload = goalsPayload();
  assert.deepEqual(
    payload.map((g) => g.id),
    EXPECTED_IDS,
  );
  for (const item of payload) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'label']);
    assert.deepEqual(Object.keys(item.label).sort(), ['en', 'es', 'ru']);
  }
  assert.equal(JSON.stringify(payload).includes('candidateOffers'), false);
});

test('goals: the picker copy exists in all three dictionaries with matching placeholders', () => {
  const varsOf = (value: string) => new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  for (const key of ['goals.title', 'goals.hint', 'goals.limit', 'goals.counter', 'goals.clear'] as const) {
    for (const dict of [en, ru, es] as Record<string, string>[]) {
      assert.ok(dict[key], `${key} missing`);
    }
    const expected = varsOf(en[key]);
    for (const dict of [ru, es] as Record<string, string>[]) {
      const value = dict[key];
      assert.ok(value, `${key} missing`);
      assert.deepEqual([...varsOf(value)].sort(), [...expected].sort(), `${key}: placeholder mismatch`);
    }
  }
  assert.deepEqual([...varsOf(en['goals.counter'])].sort(), ['max', 'n']);
});

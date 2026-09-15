import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROWTH_REASON_CODES,
  USEFUL_REASON_CODES,
  buildGrowthReasons,
  buildUsefulReasons,
  formatReasonLine,
  formatReasonV4,
  isUsefulCode,
  lineOf,
  type ReasonV4,
  type ReasonV4Facts,
  type ReasonV4Templates,
} from '../../src/domain/reasons-v4';
import { REASON_CODES } from '../../src/domain/reasons';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';

/** The v4 two-line vocabulary (§B3): codes, lines, rendering and i18n coverage. */

const EMPTY_FACTS: ReasonV4Facts = {
  goalsAdvanced: [],
  needsCovered: [],
  mutualNeeds: [],
  sharedInterests: [],
  complementaryFunctions: null,
  sameFunction: null,
  sameIndustry: null,
  teachableOffers: [],
  helpableNeeds: [],
  outsideCircle: false,
  differentContext: null,
};

const labelOf = (kind: string, id: string) => `${kind}:${id}`;

const TEMPLATES: ReasonV4Templates = {
  useful: {
    goal_advanced: 'Goal {goal}',
    need_covered: 'Need {need}',
    mutual_needs: 'Mutual {need}',
    shared_interests: 'Interests {interests}',
    complementary_functions: 'Pair {mine}+{theirs}',
    same_context: 'Context {speciality}',
    peer_context: 'Peer',
  },
  growth: {
    can_teach: 'Teach {offer}',
    wants_your_help: 'Help {need}',
    outside_circle: 'Outside',
    different_context: 'Different {speciality}',
  },
};

test('v4 codes: every code belongs to exactly one line', () => {
  for (const code of USEFUL_REASON_CODES) {
    assert.equal(isUsefulCode(code), true);
    assert.equal(lineOf(code), 'useful');
  }
  for (const code of GROWTH_REASON_CODES) {
    assert.equal(isUsefulCode(code), false);
    assert.equal(lineOf(code), 'growth');
  }
  const all = [...USEFUL_REASON_CODES, ...GROWTH_REASON_CODES];
  assert.equal(new Set(all).size, all.length, 'a code cannot be on both lines');
  // The v3 vocabulary is a different dictionary and stays untouched by v4.
  assert.deepEqual([...REASON_CODES], [
    'intent_need_covered',
    'intent_offer_match',
    'shared_interests',
    'shared_function',
    'same_industry',
    'shared_tag',
  ]);
});

test('v4 builders: line 1 is ordered by specificity and capped at three', () => {
  const reasons = buildUsefulReasons({
    ...EMPTY_FACTS,
    goalsAdvanced: ['fundraise'],
    needsCovered: ['seeking-investment'],
    mutualNeeds: ['seeking-mentor'],
    sharedInterests: ['ai-ml'],
    sameIndustry: 'ai-saas',
  });
  assert.deepEqual(
    reasons.map((r) => r.code),
    ['goal_advanced', 'need_covered', 'mutual_needs'],
  );
  assert.ok(reasons.length <= 3);
});

test('v4 builders: line 1 falls back to facts, and functions before industry-only', () => {
  assert.deepEqual(
    buildUsefulReasons({ ...EMPTY_FACTS, sharedInterests: ['ai-ml'], sameFunction: 'design' }).map((r) => r.code),
    ['shared_interests', 'same_context'],
  );
  assert.deepEqual(
    buildUsefulReasons({ ...EMPTY_FACTS, complementaryFunctions: ['design', 'engineering'] })[0]?.params,
    { mine: 'design', theirs: 'engineering' },
  );
  assert.deepEqual(buildUsefulReasons(EMPTY_FACTS), [], 'nothing to say is an empty line, not a filler sentence');
});

test('v4 builders: line 2 teaches first, then asks for help, then the new circle', () => {
  const reasons = buildGrowthReasons({
    ...EMPTY_FACTS,
    teachableOffers: ['mentoring'],
    helpableNeeds: ['seeking-mentor'],
    outsideCircle: true,
  });
  assert.deepEqual(
    reasons.map((r) => r.code),
    ['can_teach', 'wants_your_help', 'outside_circle'],
  );
  assert.deepEqual(buildGrowthReasons({ ...EMPTY_FACTS }).length, 0);
});

test('v4 rendering: labels are resolved through the caller, and a blank fact drops the sentence', () => {
  const reason: ReasonV4 = { code: 'goal_advanced', params: { goal: 'fundraise' } };
  assert.equal(formatReasonV4(reason, TEMPLATES, labelOf), 'Goal goal:fundraise');
  // An unknown goal id still renders (labelOf returns the id) …
  assert.equal(formatReasonV4(reason, TEMPLATES, () => 'fundraise'), 'Goal fundraise');
  // … but a MISSING param collapses the sentence rather than printing "{goal}".
  assert.equal(formatReasonV4({ code: 'goal_advanced', params: {} }, TEMPLATES, labelOf), '');
  // An unknown code for the line falls back to empty, never to a raw key.
  assert.equal(formatReasonV4({ code: 'peer_context', params: {} }, { useful: {}, growth: {} }, labelOf), '');
});

test('v4 rendering: the peer sentence is template-only, and both codes stay on their line', () => {
  assert.equal(formatReasonV4({ code: 'peer_context', params: {} }, TEMPLATES, labelOf), 'Peer');
  assert.equal(formatReasonV4({ code: 'outside_circle', params: {} }, TEMPLATES, labelOf), 'Outside');
  const lines = formatReasonLine(
    [
      { code: 'shared_interests', params: { interests: ['ai-ml', 'startups'] } },
      { code: 'goal_advanced', params: {} },
      { code: 'same_context', params: { industry: 'ai-saas' } },
    ],
    TEMPLATES,
    labelOf,
  );
  assert.deepEqual(lines, ['Interests interest:ai-ml, interest:startups', 'Context industry:ai-saas']);
});

test('v4 i18n: every code has a template in EN/RU/ES', () => {
  const dictionaries = { en, ru, es };
  for (const code of USEFUL_REASON_CODES) {
    for (const [locale, dict] of Object.entries(dictionaries)) {
      assert.ok(`reason4.useful.${code}` in dict, `reason4.useful.${code} missing from ${locale}`);
    }
  }
  for (const code of GROWTH_REASON_CODES) {
    for (const [locale, dict] of Object.entries(dictionaries)) {
      assert.ok(`reason4.growth.${code}` in dict, `reason4.growth.${code} missing from ${locale}`);
    }
  }
  for (const key of ['reason4.usefulLabel', 'reason4.growthLabel'] as const) {
    for (const [locale, dict] of Object.entries(dictionaries)) {
      assert.ok(key in dict, `${key} missing from ${locale}`);
    }
  }
  // The two line labels are different words — the design's whole point.
  assert.notEqual(en['reason4.usefulLabel'], en['reason4.growthLabel']);
});

test('v4 i18n: the mode switcher and the exclusion explanations exist in EN/RU/ES', () => {
  const dictionaries = { en, ru, es };
  const keys = [
    'directory.recModes.useful',
    'directory.recModes.grow',
    'directory.recModes.similar',
    'directory.recModes.explore',
    'directory.recExcluded.no_candidates',
    'directory.recExcluded.gate_not_met',
    'directory.recExcluded.no_shared_topic',
  ];
  for (const key of keys) {
    for (const [locale, dict] of Object.entries(dictionaries)) {
      assert.ok(key in dict, `${key} missing from ${locale}`);
    }
  }
});

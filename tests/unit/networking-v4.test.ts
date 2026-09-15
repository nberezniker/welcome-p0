import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPLEMENTARITY_THRESHOLD,
  NETWORKING_ALGORITHM,
  NETWORKING_ALGORITHM_V4,
  RECOMMENDATION_MODES,
  V4_COMPLEMENTARY_FUNCTIONS,
  V4_MODE_WEIGHTS,
  isRecommendationMode,
  rankCandidates,
  scoreNetworking,
  usefulnessScore,
  type RecommendationMode,
  type UsefulnessProfileInput,
} from '../../src/domain/networking-score';

/**
 * Matching v4 (social/matching design §B1/§B4): the usefulness formula, the
 * complementarity matrix, goal alignment, the novelty penalty and the four modes.
 *
 * The v3 layer is asserted UNCHANGED at the bottom of this file: v4 is additive,
 * and the frozen parity test (tests/unit/matching-parity.test.ts) must stay the
 * only thing that decides whether the tag core moved.
 */

function profile(overrides: Partial<UsefulnessProfileInput> & { id: string }): UsefulnessProfileInput {
  return { eligible: true, ...overrides };
}

const components = (over: Partial<Record<string, number>> = {}) => ({
  intentFit: 0,
  interestOverlap: 0,
  complementarity: 0,
  goalAlignment: 0,
  novelty: 0,
  functionMatch: 0 as 0 | 1,
  industryMatch: 0 as 0 | 1,
  learningFit: 0,
  otherHasFunction: true,
  otherHasIndustry: true,
  ...over,
});

// ---------------------------------------------------------------------------
// Weights and the documented formula
// ---------------------------------------------------------------------------

test('v4: the default weights are exactly the documented ones', () => {
  const w = V4_MODE_WEIGHTS.useful;
  assert.equal(w.intentFit, 0.3);
  assert.equal(w.interestOverlap, 0.2);
  assert.equal(w.complementarity, 0.25);
  assert.equal(w.goalAlignment, 0.15);
  assert.equal(w.novelty, 0.1);
  assert.equal(w.focus, null, 'the default mode has no extra component');
});

test('v4: every mode\'s weights sum to exactly 1', () => {
  for (const mode of RECOMMENDATION_MODES) {
    const w = V4_MODE_WEIGHTS[mode];
    const total = w.intentFit + w.interestOverlap + w.complementarity + w.goalAlignment + (w.focus?.weight ?? 0) + w.novelty;
    assert.ok(Math.abs(total - 1) < 1e-9, `${mode}: weights sum to ${total}`);
  }
});

test('v4: usefulness is the literal formula from the design (mode = useful)', () => {
  const c = components({ intentFit: 1, interestOverlap: 0.5, complementarity: 0.5, goalAlignment: 0.5, novelty: 1 });
  const expected = 0.3 * 1 + 0.2 * 0.5 + 0.25 * 0.5 + 0.15 * 0.5 + 0.1 * 1;
  assert.ok(Math.abs(usefulnessScore('useful', c) - expected) < 1e-9);

  // Totality: extremes stay inside [0,1].
  assert.equal(usefulnessScore('useful', components({ intentFit: 1, interestOverlap: 1, complementarity: 1, goalAlignment: 1, novelty: 1 })), 1);
  assert.equal(usefulnessScore('useful', components()), 0);
});

test('v4: mode values are validated, never guessed', () => {
  assert.deepEqual([...RECOMMENDATION_MODES], ['useful', 'grow', 'similar', 'explore']);
  assert.equal(isRecommendationMode('useful'), true);
  assert.equal(isRecommendationMode('Useful'), false);
  assert.equal(isRecommendationMode('best'), false);
  assert.equal(isRecommendationMode(null), false);
});

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

test('v4: intentFit weights the viewer\'s own priority order (first need first)', () => {
  const viewer = profile({ id: 'v', needIntents: ['seeking-cofounder', 'seeking-mentor', 'seeking-venue'] });
  const coversFirst = profile({ id: 'a', offerIntents: ['open-to-cofound'] });
  const coversLast = profile({ id: 'b', offerIntents: ['offering-venue'] });

  const first = rankCandidates(viewer, [coversFirst], 'useful', 1).items[0]!;
  const last = rankCandidates(viewer, [coversLast], 'useful', 1).items[0]!;
  // Harmonic weights: 1, 1/2, 1/3 — so closing need #1 is worth 1/1.833 of the
  // request, and closing need #3 only (1/3)/1.833.
  const total = 1 + 1 / 2 + 1 / 3;
  assert.ok(Math.abs(first.components.intentFit - 1 / total) < 1e-9, `intentFit ${first.components.intentFit}`);
  assert.ok(Math.abs(last.components.intentFit - 1 / 3 / total) < 1e-9, `intentFit ${last.components.intentFit}`);
  assert.ok(first.components.intentFit > last.components.intentFit, 'priority decides, not the count');
  assert.ok(first.score > last.score);
});

test('v4: the complementarity matrix is the six documented pairs', () => {
  assert.deepEqual(
    V4_COMPLEMENTARY_FUNCTIONS.map((p) => [...p]),
    [
      ['founder-ceo', 'investor'],
      ['design', 'engineering'],
      ['sales-bd', 'product'],
      ['product', 'engineering'],
      ['marketing', 'sales-bd'],
      ['hr-people', 'operations'],
    ],
  );

  for (const [x, y] of V4_COMPLEMENTARY_FUNCTIONS) {
    // Direction-agnostic: the pair is useful either way round.
    for (const [left, right] of [
      [x, y],
      [y, x],
    ] as const) {
      const viewer = profile({ id: 'v', jobFunction: left, interests: ['startups'] });
      const other = profile({ id: 'o', jobFunction: right, interests: ['startups'] });
      const item = rankCandidates(viewer, [other], 'useful', 1).items[0]!;
      assert.equal(item.components.matrixComplement, 1, `${left}↔${right}`);
      assert.equal(item.components.complementarity, 1, 'a complementary pair is useful on its own');
      assert.ok(item.reasons_useful.some((r) => r.code === 'complementary_functions'));
    }
  }

  // A non-pair is judged on needs/offers only.
  const viewer = profile({ id: 'v', jobFunction: 'legal', needIntents: ['seeking-expertise'] });
  const other = profile({ id: 'o', jobFunction: 'engineering', offerIntents: ['advising'] });
  const item = rankCandidates(viewer, [other], 'useful', 1).items[0]!;
  assert.equal(item.components.matrixComplement, 0);
  assert.equal(item.components.complementarity, 1, 'the single request is fully closed');
});

test('v4: complementarity also comes from mutual needs×offers, not only from functions', () => {
  const viewer = profile({ id: 'v', jobFunction: 'legal', needIntents: ['seeking-mentor'], offerIntents: ['open-to-cofound'] });
  const other = profile({ id: 'o', jobFunction: 'student', offerIntents: ['mentoring'], needIntents: ['seeking-cofounder'] });
  const item = rankCandidates(viewer, [other], 'useful', 1).items[0]!;
  assert.equal(item.components.matrixComplement, 0);
  assert.equal(item.components.complementarity, 1, 'the single request on each side is closed');
  assert.ok(item.reasons_useful.some((r) => r.code === 'mutual_needs'));
});

test('v4: goalAlignment is 1 on a direct hit, 0.5 on an interest-level hit, 0 for an unrelated goal', () => {
  const candidates = [profile({ id: 'c', offerIntents: ['investing'] })];

  const direct = rankCandidates(
    profile({ id: 'v', goals: ['fundraise'], needIntents: ['seeking-investment'] }),
    candidates,
    'useful',
    1,
  ).items[0]!;
  assert.equal(direct.components.goalAlignment, 1);
  assert.deepEqual(
    direct.reasons_useful.find((r) => r.code === 'goal_advanced')?.params,
    { goal: 'fundraise' },
  );

  // `fundraise` also lists fundraising/VC interests → 0.5 on that signal alone.
  const interestLevel = rankCandidates(
    profile({ id: 'v', goals: ['fundraise'], needIntents: ['seeking-expertise'] }),
    [profile({ id: 'c', interests: ['venture-capital'], offerIntents: ['advising'] })],
    'useful',
    1,
  ).items[0]!;
  assert.equal(interestLevel.components.goalAlignment, 0.5);

  // An unrelated goal gets nothing — and the broad one gets a neutral 0.5.
  const unrelated = rankCandidates(
    profile({ id: 'v', goals: ['get-hired'], needIntents: ['seeking-expertise'] }),
    [profile({ id: 'c', interests: ['venture-capital'], offerIntents: ['advising'] })],
    'useful',
    1,
  ).items[0]!;
  assert.equal(unrelated.components.goalAlignment, 0);
  const broad = rankCandidates(
    profile({ id: 'v', goals: ['grow-network'], needIntents: ['seeking-investment'] }),
    candidates,
    'useful',
    1,
  ).items[0]!;
  assert.equal(broad.components.goalAlignment, 0.5);
});

test('v4: goals are priority-ordered and the first one weighs most', () => {
  const candidate = profile({ id: 'c', offerIntents: ['investing'], interests: ['venture-capital'] });
  const viewerNeeds = ['seeking-investment'];
  const candidate2 = profile({ id: 'c', offerIntents: ['investing', 'open-to-work'], interests: ['venture-capital'] });
  const firstIsFundraise = rankCandidates(
    profile({ id: 'v', goals: ['fundraise', 'get-hired'], needIntents: viewerNeeds }),
    [candidate2],
    'useful',
    1,
  ).items[0]!;
  const secondIsFundraise = rankCandidates(
    profile({ id: 'v', goals: ['get-hired', 'fundraise'], needIntents: viewerNeeds }),
    [candidate2],
    'useful',
    1,
  ).items[0]!;
  assert.ok(firstIsFundraise.components.goalAlignment > secondIsFundraise.components.goalAlignment);
  void candidate;
});

test('v4: no goals means no goalAlignment — never a penalty or a bonus', () => {
  const candidate = profile({ id: 'c', offerIntents: ['investing'] });
  const noGoals = rankCandidates(
    profile({ id: 'v', needIntents: ['seeking-investment'] }),
    [candidate],
    'useful',
    1,
  ).items[0]!;
  assert.equal(noGoals.components.goalAlignment, 0);
  assert.ok(noGoals.score > 0, 'and the pair is still recommended — a goal is a bonus, not a requirement');
});

// ---------------------------------------------------------------------------
// Novelty, determinism, recency
// ---------------------------------------------------------------------------

test('v4: novelty penalizes a clone instead of showing the same person twice', () => {
  const viewer = profile({ id: 'v', needIntents: ['seeking-expertise'], interests: ['ai-ml'] });
  const clone = profile({ id: 'a', offerIntents: ['advising'], interests: ['ai-ml'], industry: 'ai-saas', jobFunction: 'engineering' });
  const twin = profile({ id: 'b', offerIntents: ['advising'], interests: ['ai-ml'], industry: 'ai-saas', jobFunction: 'engineering' });
  const diverse = profile({ id: 'c', offerIntents: ['advising'], interests: ['ai-ml'], industry: 'beauty', jobFunction: 'design' });

  const ranked = rankCandidates(viewer, [clone, twin, diverse], 'useful', 3).items;
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0]!.components.novelty, 1, 'the first pick is never penalized');
  const cloneOfFirst = ranked.find((i) => i.id === 'b')!;
  const otherOfFirst = ranked.find((i) => i.id === 'c')!;
  assert.ok(cloneOfFirst.components.novelty < otherOfFirst.components.novelty);
  assert.ok(cloneOfFirst.score < otherOfFirst.score, 'the diverse candidate wins at equal base facts');
});

test('v4: ranking is deterministic — same input, same output', () => {
  const viewer = profile({ id: 'v', needIntents: ['seeking-cofounder'], interests: ['ai-ml', 'startups'], goals: ['find-cofounder'] });
  const candidates = [
    profile({ id: 'a', offerIntents: ['open-to-cofound'], interests: ['ai-ml'] }),
    profile({ id: 'b', offerIntents: ['open-to-partner'], interests: ['startups'] }),
    profile({ id: 'c', offerIntents: ['mentoring'], interests: ['ai-ml', 'design-systems'] }),
  ];
  const first = rankCandidates(viewer, candidates, 'useful', 3);
  const second = rankCandidates(viewer, candidates, 'useful', 3);
  assert.deepEqual(first, second);

  const shuffled = rankCandidates(viewer, [candidates[2]!, candidates[0]!, candidates[1]!], 'useful', 3);
  assert.deepEqual(
    shuffled.items.map((i) => i.id),
    first.items.map((i) => i.id),
    'input order must not decide the output',
  );
});

test('v4: recency breaks ties but never enters the score', () => {
  const viewer = profile({ id: 'v', needIntents: ['seeking-expertise'] });
  const older = profile({ id: 'a', offerIntents: ['advising'], recency: 1_000 });
  const newer = profile({ id: 'b', offerIntents: ['advising'], recency: 9_000 });

  const ranked = rankCandidates(viewer, [older, newer], 'useful', 2).items;
  assert.deepEqual(ranked.map((i) => i.id), ['b', 'a'], 'the more recent pair comes first');

  // Scored alone (no novelty interaction) the two are identical: the only thing
  // that separates them is recency, which is therefore outside the formula.
  const alone = rankCandidates(viewer, [older], 'useful', 1).items[0]!;
  const aloneNewer = rankCandidates(viewer, [newer], 'useful', 1).items[0]!;
  assert.equal(alone.score, aloneNewer.score);

  // With no recency signal at all the order falls back to the id, not to luck.
  const noSignal = rankCandidates(
    viewer,
    [profile({ id: 'b', offerIntents: ['advising'] }), profile({ id: 'a', offerIntents: ['advising'] })],
    'useful',
    2,
  );
  assert.deepEqual(noSignal.items.map((i) => i.id), ['a', 'b']);
});

test('v4: scores are integers in 0..100 and carry the v4 algorithm marker', () => {
  const viewer = profile({ id: 'v', needIntents: ['seeking-cofounder'], interests: ['ai-ml'], goals: ['find-cofounder'] });
  const ranked = rankCandidates(
    viewer,
    [
      profile({ id: 'a', offerIntents: ['open-to-cofound'], interests: ['ai-ml'] }),
      profile({ id: 'b', interests: ['ai-ml'] }),
    ],
    'useful',
    5,
  );
  for (const item of ranked.items) {
    assert.equal(Number.isInteger(item.score), true);
    assert.ok(item.score >= 0 && item.score <= 100, `score ${item.score}`);
    assert.equal(item.algorithm, NETWORKING_ALGORITHM_V4);
    assert.equal(item.mode, 'useful');
  }
});

// ---------------------------------------------------------------------------
// Gates and modes (§B1 / §B4)
// ---------------------------------------------------------------------------

test('v4 mode=useful: the gate is the v3 gate AND complementarity >= threshold', () => {
  // Interest-only pair: v3-eligible, but nothing complementary about it.
  const viewer = profile({ id: 'v', interests: ['ai-ml', 'startups', 'saas'] });
  const twin = profile({ id: 'a', interests: ['ai-ml', 'startups', 'design-systems'] });
  assert.ok(scoreNetworking(viewer, twin)!.eligible, 'v3 would show this pair');

  const useful = rankCandidates(viewer, [twin], 'useful', 3);
  assert.equal(useful.items.length, 0);
  assert.equal(useful.excluded_count, 1);
  assert.equal(useful.excluded_reason, 'gate_not_met');

  // …and the same pair is exactly what "similar" is for.
  const similar = rankCandidates(viewer, [twin], 'similar', 3);
  assert.equal(similar.items.length, 1);
  assert.ok(similar.items[0]!.components.complementarity < COMPLEMENTARITY_THRESHOLD);
});

test('v4: each mode asks its own question and returns a different order', () => {
  const viewer = profile({
    id: 'v',
    needIntents: ['seeking-mentor'],
    offerIntents: ['mentoring'],
    interests: ['ai-ml', 'startups'],
    industry: 'ai-saas',
    jobFunction: 'founder-ceo',
    goals: ['learn-skill'],
  });
  const peer = profile({ id: 'peer', industry: 'ai-saas', jobFunction: 'founder-ceo', interests: ['ai-ml', 'startups'] });
  const teacher = profile({ id: 'teacher', offerIntents: ['mentoring'], interests: ['ai-ml'] });
  const outsider = profile({ id: 'outside', jobFunction: 'design', industry: 'beauty', interests: ['ai-ml'] });

  const ids = (mode: RecommendationMode) => rankCandidates(viewer, [peer, teacher, outsider], mode, 3).items.map((i) => i.id);

  assert.equal(ids('useful')[0], 'teacher', 'the mentor closes the viewer request');
  assert.equal(ids('grow')[0], 'teacher', 'grow looks for someone to learn from');
  assert.equal(ids('similar')[0], 'peer', 'similar looks for a peer');
  assert.equal(ids('explore')[0], 'outside', 'explore looks for a different context sharing the topic');

  // Every mode still produces the same shape.
  for (const mode of RECOMMENDATION_MODES) {
    for (const item of rankCandidates(viewer, [peer, teacher, outsider], mode, 3).items) {
      assert.equal(item.mode, mode);
      assert.ok(Array.isArray(item.reasons_useful) && Array.isArray(item.reasons_growth));
    }
  }
});

test('v4 mode=explore: without a shared topic there is nothing to widen', () => {
  const viewer = profile({ id: 'v', interests: ['ai-ml'] });
  const stranger = profile({ id: 'a', interests: ['skincare'], jobFunction: 'design', industry: 'beauty' });
  const ranked = rankCandidates(viewer, [stranger], 'explore', 3);
  assert.equal(ranked.items.length, 0);
  assert.equal(ranked.excluded_reason, 'no_shared_topic');
});

test('v4: excluded_reason explains an empty list, and is null otherwise', () => {
  const viewer = profile({ id: 'v', needIntents: ['seeking-cofounder'] });
  const good = profile({ id: 'a', offerIntents: ['open-to-cofound'] });

  assert.equal(rankCandidates(viewer, [], 'useful', 3).excluded_reason, 'no_candidates');
  assert.equal(rankCandidates(viewer, [good], 'useful', 3).excluded_reason, null);
  assert.equal(rankCandidates(viewer, [profile({ id: 'x', interests: ['ai-ml'] })], 'useful', 3).excluded_reason, 'gate_not_met');
});

test('v4: ineligible, blocked and self candidates are never considered', () => {
  const viewer = profile({ id: 'v', needIntents: ['seeking-cofounder'] });
  const ranked = rankCandidates(
    viewer,
    [
      profile({ id: 'v', offerIntents: ['open-to-cofound'] }),
      profile({ id: 'blocked', eligible: true, blocked: true, offerIntents: ['open-to-cofound'] }),
      profile({ id: 'ineligible', eligible: false, offerIntents: ['open-to-cofound'] }),
      profile({ id: 'ok', offerIntents: ['open-to-cofound'] }),
    ],
    'useful',
    5,
  );
  assert.deepEqual(
    ranked.items.map((i) => i.id),
    ['ok'],
  );
  assert.equal(ranked.excluded_count, 0, 'a non-candidate is not a gate rejection');
});

test('v4: the limit is honoured, and a zero limit returns nothing but still explains', () => {
  const viewer = profile({ id: 'v', needIntents: ['seeking-cofounder'] });
  const pool = ['a', 'b', 'c', 'd'].map((id, index) =>
    profile({ id, offerIntents: ['open-to-cofound'], interests: ['ai-ml'], recency: index * 100 }),
  );
  assert.equal(rankCandidates(viewer, pool, 'useful', 2).items.length, 2);
  assert.equal(rankCandidates(viewer, pool, 'useful', 0).items.length, 0);
  assert.equal(rankCandidates(viewer, pool, 'useful', -1).items.length, 0);
  assert.equal(rankCandidates(viewer, pool, 'useful', 99).items.length, 4);
});

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

test('v4 reasons: line 1 explains the usefulness, line 2 the development', () => {
  const viewer = profile({
    id: 'v',
    needIntents: ['seeking-cofounder'],
    offerIntents: ['mentoring'],
    interests: ['ai-ml'],
    industry: 'ai-saas',
    jobFunction: 'founder-ceo',
    goals: ['find-cofounder'],
  });
  const other = profile({
    id: 'a',
    offerIntents: ['open-to-cofound'],
    needIntents: ['seeking-mentor'],
    interests: ['ai-ml'],
    industry: 'ai-saas',
    jobFunction: 'engineering',
  });
  const item = rankCandidates(viewer, [other], 'useful', 1).items[0]!;

  const usefulCodes = item.reasons_useful.map((r) => r.code);
  // Three sentences per line, the most specific first: the goal, then the
  // request, then the reciprocity.
  assert.deepEqual(usefulCodes, ['goal_advanced', 'need_covered', 'mutual_needs']);
  assert.deepEqual(
    item.reasons_useful.find((r) => r.code === 'need_covered')?.params,
    { need: 'seeking-cofounder' },
  );

  const growthCodes = item.reasons_growth.map((r) => r.code);
  assert.ok(growthCodes.includes('wants_your_help'), 'they look for the mentoring I offer');
  assert.ok(growthCodes.includes('different_context'));

  // With room left (no intents in play) the fact-based sentences appear too.
  const factsOnly = rankCandidates(
    profile({ id: 'v2', interests: ['ai-ml', 'startups'], industry: 'ai-saas' }),
    [profile({ id: 'b2', interests: ['ai-ml'], industry: 'ai-saas' })],
    'similar',
    1,
  ).items[0]!;
  const factCodes = factsOnly.reasons_useful.map((r) => r.code);
  assert.ok(factCodes.includes('shared_interests'));
  assert.ok(factCodes.includes('same_context'));

  // The two lines never share a sentence.
  const usefulSet = new Set(usefulCodes);
  for (const code of growthCodes) assert.equal(usefulSet.has(code), false, `${code} is on both lines`);
  assert.deepEqual(item.reasons_useful.length > 0, true);
  assert.ok(item.reasons_useful.length <= 3);
  assert.ok(item.reasons_growth.length <= 3);
});

test('v4 reasons: a teacher is named on the growth line', () => {
  const viewer = profile({ id: 'v', interests: ['ai-ml'] });
  const teacher = profile({ id: 't', offerIntents: ['advising'], interests: ['ai-ml'], industry: 'ai-saas' });
  const item = rankCandidates(viewer, [teacher], 'grow', 1).items[0]!;
  assert.deepEqual(
    item.reasons_growth.find((r) => r.code === 'can_teach')?.params,
    { offer: 'advising' },
  );
});

// ---------------------------------------------------------------------------
// v3 must not have moved
// ---------------------------------------------------------------------------

test('v4 is additive: scoreNetworking keeps its v3 answer for the same pair', () => {
  const a = profile({ id: 'a', needIntents: ['seeking-cofounder'], interests: ['ai-ml', 'startups', 'saas'] });
  const b = profile({ id: 'b', offerIntents: ['open-to-cofound'], interests: ['ai-ml', 'startups', 'design-systems'] });
  const v3 = scoreNetworking(a, b)!;
  assert.equal(v3.algorithm, NETWORKING_ALGORITHM);
  assert.equal(v3.score, 45 + Math.round(100 * 0.35 * (2 / 3)));
  assert.equal(v3.intentScore, 1);
  assert.equal(v3.eligible, true);
  assert.equal(v3.reasons[0]?.code, 'intent_need_covered');
});

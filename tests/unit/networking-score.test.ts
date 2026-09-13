import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTEREST_GATE,
  NETWORKING_ALGORITHM,
  reasonsFor,
  scoreNetworking,
  type NetworkingProfileInput,
} from '../../src/domain/networking-score';

function profile(overrides: Partial<NetworkingProfileInput> & { id: string }): NetworkingProfileInput {
  return { eligible: true, ...overrides };
}

// ---------------------------------------------------------------------------
// Score components
// ---------------------------------------------------------------------------

test('score: intent complement is the gate — 45 points on its own', () => {
  const a = profile({ id: 'a', needIntents: ['seeking-cofounder'] });
  const b = profile({ id: 'b', offerIntents: ['open-to-cofound'] });
  const result = scoreNetworking(a, b)!;
  assert.ok(result);
  assert.equal(result.intentScore, 1);
  assert.equal(result.score, 45);
  assert.equal(result.eligible, true);
  assert.equal(result.algorithm, NETWORKING_ALGORITHM);
  assert.equal(result.mutualConsent, false);
});

test('score: complement works in either direction', () => {
  const a = profile({ id: 'a', offerIntents: ['open-to-cofound'] });
  const b = profile({ id: 'b', needIntents: ['seeking-cofounder'] });
  assert.equal(scoreNetworking(a, b)!.intentScore, 1);
  assert.equal(scoreNetworking(a, b)!.score, 45);
});

test('score: interest-only match passes the gate at >= 0.34', () => {
  const shared = profile({ id: 'a', interests: ['ai-ml', 'startups', 'saas'] });
  const other = profile({ id: 'b', interests: ['ai-ml', 'startups', 'design-systems'] });
  const result = scoreNetworking(shared, other)!;
  assert.equal(result.intentScore, 0);
  assert.equal(result.interestOverlap, 2 / 3);
  assert.ok(result.interestOverlap >= INTEREST_GATE);
  assert.equal(result.eligible, true);
  assert.equal(result.score, Math.round(100 * 0.35 * (2 / 3)));
});

test('score: a single shared interest out of three (0.333) does NOT pass the gate', () => {
  const a = profile({ id: 'a', interests: ['ai-ml', 'startups', 'saas'] });
  const b = profile({ id: 'b', interests: ['ai-ml', 'beauty-industry', 'salon-business'] });
  const result = scoreNetworking(a, b)!;
  assert.equal(result.interestOverlap, 1 / 3);
  assert.ok(result.interestOverlap < INTEREST_GATE);
  assert.equal(result.eligible, false);
});

test('score: interestOverlap uses max(1, min(|a|,|b|)) so a 1-interest profile can fully match', () => {
  const a = profile({ id: 'a', interests: ['ai-ml'] });
  const b = profile({ id: 'b', interests: ['ai-ml', 'startups', 'saas'] });
  const result = scoreNetworking(a, b)!;
  assert.equal(result.interestOverlap, 1);
  assert.equal(result.eligible, true);
});

test('score: function+industry passes the gate without intents or interests', () => {
  // Both sides carry v3 data (an unrelated interest each) but share no intent
  // and no interest — the function+industry clause is what makes them visible.
  const a = profile({ id: 'a', interests: ['ai-ml'], jobFunction: 'founder-ceo', industry: 'ai-saas' });
  const b = profile({ id: 'b', interests: ['fashion'], jobFunction: 'founder-ceo', industry: 'ai-saas' });
  const result = scoreNetworking(a, b)!;
  assert.equal(result.intentScore, 0);
  assert.equal(result.interestOverlap, 0);
  assert.equal(result.functionMatch, 1);
  assert.equal(result.industryMatch, 1);
  assert.equal(result.eligible, true);
  assert.equal(result.score, 20);
});

test('score: complementary functions count (founder↔investor, sales↔marketing), same industry needed for the gate', () => {
  const founder = profile({ id: 'a', interests: ['ai-ml'], jobFunction: 'founder-ceo' });
  const investor = profile({ id: 'b', interests: ['fashion'], jobFunction: 'investor' });
  assert.equal(scoreNetworking(founder, investor)!.functionMatch, 1);
  // function only → gate fails (needs function AND industry)
  assert.equal(scoreNetworking(founder, investor)!.eligible, false);

  const sameIndustryFounder = profile({ id: 'a', interests: ['ai-ml'], jobFunction: 'founder-ceo', industry: 'fintech' });
  const sameIndustryInvestor = profile({ id: 'b', interests: ['fashion'], jobFunction: 'investor', industry: 'fintech' });
  assert.equal(scoreNetworking(sameIndustryFounder, sameIndustryInvestor)!.eligible, true);

  const sales = profile({ id: 'c', interests: ['ai-ml'], jobFunction: 'sales-bd' });
  const marketing = profile({ id: 'd', interests: ['fashion'], jobFunction: 'marketing' });
  assert.equal(scoreNetworking(sales, marketing)!.functionMatch, 1);
});

test('score: a full match across all four components is exactly 100', () => {
  const a = profile({
    id: 'a',
    needIntents: ['seeking-cofounder'],
    offerIntents: ['investing'],
    interests: ['ai-ml', 'startups', 'saas'],
    jobFunction: 'founder-ceo',
    industry: 'ai-saas',
  });
  const b = profile({
    id: 'b',
    needIntents: ['seeking-investment'],
    offerIntents: ['open-to-cofound'],
    interests: ['ai-ml', 'startups', 'saas'],
    jobFunction: 'founder-ceo',
    industry: 'ai-saas',
  });
  const result = scoreNetworking(a, b)!;
  assert.equal(result.intentScore, 1);
  assert.equal(result.interestOverlap, 1);
  assert.equal(result.functionMatch, 1);
  assert.equal(result.industryMatch, 1);
  assert.equal(result.score, 100);
  assert.equal(result.eligible, true);
});

test('score: profiles without v3 data are NOT scored by this layer (eligible:false)', () => {
  const legacyA = profile({ id: 'a' });
  const legacyB = profile({ id: 'b', interests: ['ai-ml'] });
  const result = scoreNetworking(legacyA, legacyB)!;
  assert.equal(result.eligible, false);
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, []);
  // either side lacking v3 data is enough
  assert.equal(scoreNetworking(legacyB, legacyA)!.eligible, false);
});

test('score: hard ineligibility returns null (same id, blocked, not eligible)', () => {
  const a = profile({ id: 'a', needIntents: ['seeking-cofounder'] });
  assert.equal(scoreNetworking(a, profile({ id: 'a', offerIntents: ['open-to-cofound'] })), null);
  assert.equal(scoreNetworking(a, profile({ id: 'b', eligible: false, offerIntents: ['open-to-cofound'] })), null);
  assert.equal(scoreNetworking(a, profile({ id: 'b', blocked: true, offerIntents: ['open-to-cofound'] })), null);
  assert.throws(
    () => scoreNetworking({ id: 5 } as unknown as NetworkingProfileInput, a),
    TypeError,
  );
});

test('score: unknown / stale values are ignored, not crashed on', () => {
  const a = profile({ id: 'a', needIntents: ['seeking-cofounder', 'made-up'], interests: ['ai-ml', 'nope'] });
  const b = profile({ id: 'b', offerIntents: ['open-to-cofound', 42], interests: ['ai-ml'], industry: 'nowhere' });
  const result = scoreNetworking(a, b)!;
  assert.equal(result.intentScore, 1);
  assert.equal(result.interestOverlap, 1);
  assert.equal(result.industryMatch, 0);
});

test('score: same industry requires both sides to be set', () => {
  const a = profile({ id: 'a', interests: ['ai-ml'], industry: 'fintech' });
  const b = profile({ id: 'b', interests: ['fashion'], industry: 'fintech' });
  assert.equal(scoreNetworking(a, b)!.industryMatch, 1);
  const c = profile({ id: 'c', interests: ['fashion'], industry: null });
  assert.equal(scoreNetworking(a, c)!.industryMatch, 0);
  const d = profile({ id: 'd', interests: ['fashion'] });
  assert.equal(scoreNetworking(a, d)!.industryMatch, 0);
});

// ---------------------------------------------------------------------------
// Reasons — structural codes, not rendered text
// ---------------------------------------------------------------------------

test('reasonsFor: an intent the viewer offers becomes intent_offer_match with catalogue ids', () => {
  const viewer = profile({ id: 'me', offerIntents: ['open-to-cofound'] });
  const other = profile({ id: 'them', needIntents: ['seeking-cofounder'] });
  assert.deepEqual(reasonsFor(viewer, other), [
    { code: 'intent_offer_match', params: { need: 'seeking-cofounder', offer: 'open-to-cofound' } },
  ]);
});

test('reasonsFor: the reverse direction is a different code for the same pair', () => {
  const viewer = profile({ id: 'me', needIntents: ['seeking-cofounder'] });
  const other = profile({ id: 'them', offerIntents: ['open-to-cofound'] });
  assert.deepEqual(reasonsFor(viewer, other), [
    { code: 'intent_need_covered', params: { need: 'seeking-cofounder', offer: 'open-to-cofound' } },
  ]);
  // Mirrored viewpoint: same facts, opposite codes — reasons_for_me and
  // reasons_for_them can never be the same list.
  assert.deepEqual(reasonsFor(other, viewer), [
    { code: 'intent_offer_match', params: { need: 'seeking-cofounder', offer: 'open-to-cofound' } },
  ]);
});

test('reasonsFor: interest + context reasons, catalogue-ordered', () => {
  const viewer = profile({
    id: 'me',
    needIntents: ['seeking-cofounder'],
    offerIntents: ['investing'],
    interests: ['startups', 'ai-ml'],
    jobFunction: 'founder-ceo',
    industry: 'ai-saas',
  });
  const other = profile({
    id: 'them',
    needIntents: ['seeking-investment'],
    offerIntents: ['open-to-cofound'],
    interests: ['ai-ml', 'startups', 'saas'],
    jobFunction: 'founder-ceo',
    industry: 'ai-saas',
  });
  assert.deepEqual(reasonsFor(viewer, other), [
    { code: 'intent_need_covered', params: { need: 'seeking-cofounder', offer: 'open-to-cofound' } },
    { code: 'intent_offer_match', params: { need: 'seeking-investment', offer: 'investing' } },
    { code: 'shared_interests', params: { interests: ['ai-ml', 'startups'] } },
    { code: 'shared_function', params: { function: 'founder-ceo' } },
    { code: 'same_industry', params: { industry: 'ai-saas' } },
  ]);
});

test('reasonsFor: deterministic and independent of input order', () => {
  const a1 = profile({ id: 'me', needIntents: ['seeking-clients', 'seeking-cofounder'], interests: ['saas', 'ai-ml'] });
  const a2 = profile({ id: 'me', needIntents: ['seeking-cofounder', 'seeking-clients'], interests: ['ai-ml', 'saas'] });
  const other = profile({ id: 'them', offerIntents: ['open-to-cofound', 'offering-services'], interests: ['ai-ml', 'saas'] });
  const first = reasonsFor(a1, other);
  const second = reasonsFor(a2, other);
  assert.deepEqual(first, second);
  assert.deepEqual(reasonsFor(a1, other), reasonsFor(a1, other));
  assert.ok(first.length > 0);
});

test('reasonsFor: empty for self, unknown ids, and no visible overlap', () => {
  assert.deepEqual(reasonsFor(profile({ id: 'x' }), profile({ id: 'x' })), []);
  assert.deepEqual(reasonsFor(profile({ id: 'a' }), profile({ id: 'b' })), []);
  assert.deepEqual(
    reasonsFor(profile({ id: 'a', interests: ['ai-ml'] }), profile({ id: 'b', interests: ['fashion'] })),
    [],
  );
});

test('reasonsFor: at most 3 intent-level reasons, context reasons never counted in', () => {
  const viewer = profile({
    id: 'me',
    needIntents: ['seeking-cofounder', 'seeking-clients', 'seeking-mentor', 'seeking-venue'],
    interests: ['ai-ml'],
  });
  const other = profile({
    id: 'them',
    offerIntents: ['open-to-cofound', 'offering-services', 'mentoring', 'offering-venue'],
    interests: ['ai-ml'],
  });
  const reasons = reasonsFor(viewer, other);
  assert.equal(reasons.filter((r) => r.code === 'intent_need_covered').length, 3);
  assert.ok(reasons.some((r) => r.code === 'shared_interests'));
});

test('score result reasons mirror reasonsFor for the same pair', () => {
  const viewer = profile({ id: 'me', offerIntents: ['open-to-cofound'] });
  const other = profile({ id: 'them', needIntents: ['seeking-cofounder'], interests: ['ai-ml'] });
  const scored = scoreNetworking(viewer, other)!;
  assert.deepEqual(scored.reasons, reasonsFor(viewer, other));
});

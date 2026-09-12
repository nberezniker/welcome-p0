import test from 'node:test';
import assert from 'node:assert/strict';
// The original spec baseline is imported directly (JS — allowJs infers types).
import {
  scorePair as originalScorePair,
  recommend as originalRecommend,
  canRevealPrivate as originalCanRevealPrivate,
} from '../../spec/contracts/matching.mjs';
import {
  scorePair,
  recommend,
  canRevealPrivate,
  type MatchProfileInput,
  type CandidateInput,
} from '../../src/domain/matching';

// ---------------------------------------------------------------------------
// Core behavior (AC-27 / AC-29) and 1:1 parity with the .mjs contract
// ---------------------------------------------------------------------------

const alice: MatchProfileInput = { id: 'a', eligible: true, needs: ['frontend', 'design'], offers: ['mentoring'] };
const bob: MatchProfileInput = { id: 'b', eligible: true, needs: ['mentoring'], offers: ['frontend', 'design'] };

// Real demo geometry (scripts/seed-demo-event.mts): the owner profile needs 4
// tags of which the partner offers 2, while the partner needs 2 tags the owner
// offers in full. Asymmetric coverage: dAB = 0.5, dBA = 1.0.
const demoOwner: MatchProfileInput = {
  id: 'owner',
  eligible: true,
  offers: [
    'ai-transformation',
    'applied-ai',
    'automation',
    'sales-leadership',
    'process-design',
    'product-discovery',
    'rag',
    'mcp',
  ],
  needs: ['b2b-clients', 'ai-pilots', 'sales-growth', 'partnerships'],
};
const demoPartner: MatchProfileInput = {
  id: 'partner',
  eligible: true,
  offers: ['b2b-clients', 'ai-pilots'],
  needs: ['ai-transformation', 'automation'],
};

test('AC-27 core: complementary needs/offers produce a mutual score', () => {
  const m = scorePair(alice, bob);
  assert.ok(m);
  assert.equal(m!.score, 100);
  assert.deepEqual(m!.reasonsForA, ['frontend', 'design']); // Alice's needs covered by Bob's offers
  assert.deepEqual(m!.reasonsForB, ['mentoring']); // Bob needs mentoring, Alice offers it
  assert.equal(m!.algorithm, 'welcome_mutual_tags_v1');
  assert.equal(m!.mutualConsent, false);
});

test('AC-27 core: both seeking the same thing → null (no mutual fit)', () => {
  const a: MatchProfileInput = { id: 'a', eligible: true, needs: ['clients'], offers: [] };
  const b: MatchProfileInput = { id: 'b', eligible: true, needs: ['clients'], offers: [] };
  assert.equal(scorePair(a, b), null);
});

test('AC-27 core: one-sided fit → null (nothing to offer the other side)', () => {
  const a: MatchProfileInput = { id: 'a', eligible: true, needs: ['x'], offers: [] };
  const b: MatchProfileInput = { id: 'b', eligible: true, needs: ['y'], offers: ['x'] };
  assert.equal(scorePair(a, b), null);
  assert.equal(scorePair(b, a), null);
});

test('AC-29 core: scorePair is symmetric (same score, swapped reasons)', () => {
  const ab = scorePair(alice, bob)!;
  const ba = scorePair(bob, alice)!;
  assert.equal(ab.score, ba.score);
  assert.deepEqual(ab.reasonsForA, ba.reasonsForB);
  assert.deepEqual(ab.reasonsForB, ba.reasonsForA);
});

test('core: partial overlap computes the frozen formula exactly', () => {
  const a: MatchProfileInput = { id: 'a', eligible: true, needs: ['x', 'z'], offers: ['y'] };
  const b: MatchProfileInput = { id: 'b', eligible: true, needs: ['y', 'w'], offers: ['x'] };
  const m = scorePair(a, b)!;
  const dAB = 1 / 2;
  const dBA = 1 / 2;
  assert.equal(m.score, Math.round(100 * (0.6 * Math.min(dAB, dBA) + (0.4 * (dAB + dBA)) / 2)));
});

test('core: asymmetric coverage (0.5/1.0) computes the frozen formula exactly', () => {
  const m = scorePair(demoOwner, demoPartner)!;
  const dAB = 2 / 4;
  const dBA = 2 / 2;
  assert.equal(m.score, Math.round(100 * (0.6 * Math.min(dAB, dBA) + (0.4 * (dAB + dBA)) / 2)));
  assert.equal(m.score, 60); // 0.6*0.5 + 0.4*1.5/2 = 0.60
  assert.deepEqual(m.reasonsForA, ['b2b-clients', 'ai-pilots']); // owner needs covered by partner offers
  assert.deepEqual(m.reasonsForB, ['ai-transformation', 'automation']); // partner needs covered by owner offers

  // Score is symmetric; only the reasons swap sides.
  const back = scorePair(demoPartner, demoOwner)!;
  assert.equal(back.score, 60);
  assert.deepEqual(back.reasonsForA, m.reasonsForB);
  assert.deepEqual(back.reasonsForB, m.reasonsForA);
});

test('core: self, ineligible and blocked pairs are rejected', () => {
  assert.equal(scorePair(alice, alice), null);
  assert.equal(scorePair(alice, { ...bob, eligible: false }), null);
  assert.equal(scorePair(alice, { ...bob, blocked: true }), null);
  assert.equal(scorePair({ ...alice, blocked: true }, bob), null);
});

test('core: missing/invalid inputs throw TypeError like the original', () => {
  assert.throws(() => scorePair(null as unknown as MatchProfileInput, bob), TypeError);
  assert.throws(() => scorePair(undefined as unknown as MatchProfileInput, bob), TypeError);
  assert.throws(() => scorePair({ id: 12, needs: [], offers: [] } as unknown as MatchProfileInput, bob), TypeError);
  assert.throws(() => scorePair(alice, { id: 'x', eligible: true, needs: 'nope', offers: [] }), TypeError);
});

test('recommend: filters non-matches, sorts by score/pending/id, caps at limit', () => {
  const me: MatchProfileInput = { id: 'me', eligible: true, needs: ['a'], offers: ['b'] };
  const candidates: CandidateInput[] = [
    { id: 'c1', eligible: true, needs: ['b'], offers: ['a'], pending: 0 }, // score 100
    { id: 'c2', eligible: true, needs: ['b'], offers: ['a'], pending: 2 }, // score 100, more pending
    { id: 'c3', eligible: true, needs: ['b'], offers: ['a'], pending: 0 }, // score 100
    { id: 'c1', eligible: true, needs: ['b'], offers: ['a'], pending: 5 }, // duplicate id → dropped
    { id: 'blocked', eligible: true, blocked: true, needs: ['b'], offers: ['a'] }, // → null
    { id: 'no-fit', eligible: true, needs: ['zzz'], offers: ['qqq'] }, // → null
  ];
  const r = recommend(me, candidates, 2);
  assert.equal(r.length, 2);
  assert.equal(r[0]!.id, 'c1'); // pending 0, id 'c1' < 'c3'
  assert.equal(r[1]!.id, 'c3');
  assert.ok(r.every((x) => x.id !== 'c2' && x.id !== 'no-fit' && x.id !== 'blocked'));
  assert.ok(r.every((x) => x.match.algorithm === 'welcome_mutual_tags_v1'));

  const full = recommend(me, candidates, 3);
  assert.deepEqual(full.map((x) => x.id), ['c1', 'c3', 'c2']);
});

test('recommend: limit must be integer 0..3', () => {
  assert.throws(() => recommend(alice, [], 4), TypeError);
  assert.throws(() => recommend(alice, [], -1), TypeError);
  assert.throws(() => recommend(alice, [], 1.5), TypeError);
  assert.deepEqual(recommend(alice, [], 0), []);
  assert.deepEqual(recommend(alice, [], 3), []);
});

test('recommend: deterministic tie-break by profile id', () => {
  const me: MatchProfileInput = { id: 'me', eligible: true, needs: ['a'], offers: ['b'] };
  const candidates: CandidateInput[] = [
    { id: 'aaa', eligible: true, needs: ['b'], offers: ['a'] },
    { id: 'ccc', eligible: true, needs: ['b'], offers: ['a'] },
    { id: 'bbb', eligible: true, needs: ['b'], offers: ['a'] },
  ];
  const r = recommend(me, candidates, 3);
  assert.deepEqual(r.map((x) => x.id), ['aaa', 'bbb', 'ccc']);
});

test('canRevealPrivate: contract shape (mutually_accepted + policy version match)', () => {
  const intro = { state: 'mutually_accepted', aAccepted: true, bAccepted: true, revoked: false, consentVersion: 3 };
  const policy = { allowed: true, consentVersion: 3 };
  assert.equal(canRevealPrivate(intro, policy), true);
  assert.equal(canRevealPrivate({ ...intro, state: 'pending' }, policy), false);
  assert.equal(canRevealPrivate({ ...intro, aAccepted: false }, policy), false);
  assert.equal(canRevealPrivate({ ...intro, revoked: true }, policy), false);
  assert.equal(canRevealPrivate(intro, { ...policy, allowed: false }), false);
  assert.equal(canRevealPrivate(intro, { ...policy, consentVersion: 2 }), false);
  assert.equal(canRevealPrivate(null, policy), false);
});

// ---------------------------------------------------------------------------
// Parity vs the original .mjs on shared inputs
// ---------------------------------------------------------------------------

const parityPairs: [MatchProfileInput, MatchProfileInput][] = [
  [alice, bob],
  [bob, alice],
  [demoOwner, demoPartner],
  [demoPartner, demoOwner],
  [
    { id: 'p1', eligible: true, needs: ['a', 'b', 'c'], offers: ['x'] },
    { id: 'p2', eligible: true, needs: ['x', 'y'], offers: ['b', 'c'] },
  ],
  [{ id: 'p1', eligible: true, needs: [], offers: [] }, { id: 'p2', eligible: true, needs: [], offers: [] }],
  [{ id: 'p1', eligible: true, needs: ['a'], offers: [] }, { id: 'p2', eligible: true, needs: ['b'], offers: ['c'] }],
  [
    { id: 'p1', eligible: false, needs: ['a'], offers: ['b'] },
    { id: 'p2', eligible: true, needs: ['b'], offers: ['a'] },
  ],
  [{ id: 'p1', eligible: true, needs: ['тег', 'Design'], offers: ['frontend'] }, { id: 'p2', eligible: true, needs: ['frontend'], offers: ['тег'] }],
];

test('parity: scorePair matches the original .mjs on shared cases', () => {
  for (const [a, b] of parityPairs) {
    const ts = scorePair(a, b);
    const js = originalScorePair(a, b);
    assert.deepEqual(ts, js);
  }
});

test('parity: recommend matches the original on shared candidate lists', () => {
  const me: MatchProfileInput = { id: 'me', eligible: true, needs: ['design'], offers: ['frontend'] };
  const candidates: CandidateInput[] = [
    { id: 'c1', eligible: true, needs: ['frontend'], offers: ['design'], pending: 0 },
    { id: 'c2', eligible: true, needs: ['frontend'], offers: ['other'], pending: 3 },
    { id: 'c2b', eligible: true, needs: ['x'], offers: ['y'], pending: 0 },
    { id: 'blocked', eligible: true, blocked: true, needs: ['frontend'], offers: ['design'] },
  ];
  for (const limit of [0, 1, 2, 3]) {
    assert.deepEqual(recommend(me, candidates, limit), originalRecommend(me, candidates, limit));
  }
});

test('parity: canRevealPrivate matches the original', () => {
  const intros = [
    { state: 'mutually_accepted', aAccepted: true, bAccepted: true, revoked: false, consentVersion: 1 },
    { state: 'pending', aAccepted: false, bAccepted: false, revoked: false, consentVersion: 1 },
    null,
    undefined,
  ];
  const policies = [
    { allowed: true, consentVersion: 1 },
    { allowed: false, consentVersion: 1 },
    { allowed: true, consentVersion: 2 },
    null,
  ];
  for (const intro of intros) {
    for (const policy of policies) {
      assert.equal(canRevealPrivate(intro as never, policy as never), originalCanRevealPrivate(intro, policy));
    }
  }
});

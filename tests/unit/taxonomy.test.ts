import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NEED_INTENT_IDS,
  OFFER_INTENT_IDS,
  INTENT_IDS,
  INTENTS,
  INTERESTS,
  INTEREST_GROUPS,
  INTEREST_IDS,
  JOB_FUNCTIONS,
  INDUSTRIES,
  MAX_INTERESTS,
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  MAX_NEED_INTENTS,
  MAX_OFFER_INTENTS,
  PREFER_NOT_TO_SAY,
  complementOf,
  declaredInterestAliases,
  intentIdsOfKind,
  intentKind,
  intentLabel,
  isIntentId,
  normalizeIntentTag,
  normalizeInterest,
  normalizeKeyword,
  strictIntentForKind,
  taxonomyPayload,
  validateIndustry,
  validateInterests,
  validateJobFunction,
  validateKeywords,
  validateNeedIntents,
  validateOfferIntents,
} from '../../src/domain/taxonomy';

// ---------------------------------------------------------------------------
// Catalogue integrity
// ---------------------------------------------------------------------------

test('taxonomy: 16 intent pairs, 32 unique side ids, valid kinds', () => {
  assert.equal(INTENTS.length, 16);
  assert.equal(NEED_INTENT_IDS.length, 16);
  assert.equal(OFFER_INTENT_IDS.length, 16);
  assert.equal(new Set(INTENT_IDS).size, 32, 'intent side ids must be globally unique');
  assert.equal(intentIdsOfKind('need').length, 16);
  assert.equal(intentIdsOfKind('offer').length, 16);
  for (const pair of INTENTS) {
    assert.equal(pair.need.kind, 'need');
    assert.equal(pair.offer.kind, 'offer');
    assert.equal(intentKind(pair.need.id), 'need');
    assert.equal(intentKind(pair.offer.id), 'offer');
    assert.ok(isIntentId(pair.need.id) && isIntentId(pair.offer.id));
  }
});

test('taxonomy: complementOf is symmetric and null for unknown ids', () => {
  for (const pair of INTENTS) {
    assert.equal(complementOf(pair.need.id), pair.offer.id);
    assert.equal(complementOf(pair.offer.id), pair.need.id);
    assert.equal(complementOf(complementOf(pair.need.id)!), pair.need.id, 'complement is an involution');
  }
  assert.equal(complementOf('not-an-intent'), null);
  assert.equal(complementOf(''), null);
});

test('taxonomy: every label is non-empty in RU and EN', () => {
  for (const pair of INTENTS) {
    for (const side of [pair.need, pair.offer]) {
      assert.ok(side.label.ru.length > 0, `${side.id} ru label`);
      assert.ok(side.label.en.length > 0, `${side.id} en label`);
      assert.ok(side.goal.ru.length > 0, `${side.id} ru goal`);
      assert.ok(side.goal.en.length > 0, `${side.id} en goal`);
      assert.equal(intentLabel(side.id, 'ru'), side.label.ru);
    }
  }
  for (const interest of INTERESTS) {
    assert.ok(interest.label.ru.length > 0 && interest.label.en.length > 0, `${interest.id} labels`);
  }
  for (const facet of [...JOB_FUNCTIONS, ...INDUSTRIES]) {
    assert.ok(facet.label.ru.length > 0 && facet.label.en.length > 0, `${facet.id} labels`);
  }
});

test('taxonomy: interests are unique, grouped, and each group is used', () => {
  assert.ok(INTERESTS.length >= 70, 'catalogue must cover the ~70-interest target');
  assert.equal(new Set(INTEREST_IDS).size, INTERESTS.length, 'interest ids must be unique');
  const groupIds = new Set(INTEREST_GROUPS.map((g) => g.id));
  assert.equal(groupIds.size, INTEREST_GROUPS.length, 'group ids must be unique');
  const used = new Set<string>();
  for (const interest of INTERESTS) {
    assert.ok(groupIds.has(interest.group), `${interest.id} references unknown group ${interest.group}`);
    used.add(interest.group);
  }
  for (const g of groupIds) assert.ok(used.has(g), `group ${g} has no interests`);
  assert.equal(JOB_FUNCTIONS.length, 14);
  assert.equal(INDUSTRIES.length, 12);
});

test('taxonomy: an alias string is never declared by two interests', () => {
  const aliases = declaredInterestAliases();
  assert.equal(new Set(aliases).size, aliases.length, 'duplicate alias across interests');
  assert.ok(aliases.length > INTERESTS.length, 'aliases must add RU/EN + legacy variants');
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test('normalizeInterest: canonical ids, RU/EN aliases and legacy v1 ids resolve', () => {
  const cases: [unknown, string | null][] = [
    ['ai-ml', 'ai-ml'],
    ['AI', 'ai-ml'],
    ['ИИ', 'ai-ml'],
    ['  искусственный   интеллект ', 'ai-ml'],
    ['машинное обучение', 'ai-ml'],
    ['rag-systems', 'ai-ml'],
    ['Стартапы', 'startups'],
    ['design', 'ux-ui'],
    ['UX/UI', 'ux-ui'],
    ['фронтенд', null],
    ['mcp-integrations', 'dev-tools'],
    ['интернет-магазин', 'retail-ecommerce'],
    ['фудтех', 'food-restaurants'],
    ['нетворкинг', 'local-community'],
    ['unknown-topic-xyz', null],
    ['', null],
    [42, null],
    [null, null],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(normalizeInterest(raw), expected, `normalizeInterest(${JSON.stringify(raw)})`);
  }
});

test('normalizeKeyword: trims, lowercases, collapses whitespace, truncates over-long input', () => {
  assert.equal(normalizeKeyword('  ФудТех  стартап '), 'фудтех стартап');
  assert.equal(normalizeKeyword(''), null);
  assert.equal(normalizeKeyword(null), null);
  assert.equal(normalizeKeyword('x'.repeat(60))!.length, MAX_KEYWORD_LENGTH);
});

test('intent tag resolution: lenient flips sides, strict rejects the wrong side', () => {
  // lenient (legacy rows + data migration)
  assert.equal(normalizeIntentTag('distribution', 'need'), 'seeking-distribution');
  assert.equal(normalizeIntentTag('distribution', 'offer'), 'distribution-ready');
  assert.equal(normalizeIntentTag('mentoring', 'offer'), 'mentoring');
  assert.equal(normalizeIntentTag('mentoring', 'need'), 'seeking-mentor');
  assert.equal(normalizeIntentTag('pilot', 'offer'), 'pilot-ready');
  assert.equal(normalizeIntentTag('open-to-cofound', 'need'), 'seeking-cofounder');
  assert.equal(normalizeIntentTag('nonsense', 'need'), null);
  // strict (API input)
  assert.equal(strictIntentForKind('mentoring', 'offer'), 'mentoring');
  assert.equal(strictIntentForKind('mentoring', 'need'), null);
  assert.equal(strictIntentForKind('open-to-cofound', 'need'), null);
  assert.equal(strictIntentForKind('seeking-cofounder', 'need'), 'seeking-cofounder');
});

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

test('validators: intents — defaults, dedupe, limits, wrong-side and unknown ids', () => {
  assert.deepEqual(validateNeedIntents(undefined), { ok: true, value: [] });
  assert.deepEqual(validateNeedIntents([]), { ok: true, value: [] });
  assert.deepEqual(validateNeedIntents(['seeking-cofounder', 'seeking-cofounder']), {
    ok: true,
    value: ['seeking-cofounder'],
  });
  assert.deepEqual(validateOfferIntents(['open-to-cofound', 'investing']), {
    ok: true,
    value: ['open-to-cofound', 'investing'],
  });

  const over = validateNeedIntents(['seeking-cofounder', 'seeking-clients', 'hiring', 'seeking-partner']);
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.code, 'invalid_need_intents');

  const wrongSide = validateOfferIntents(['seeking-cofounder']);
  assert.equal(wrongSide.ok, false);
  if (!wrongSide.ok) assert.equal(wrongSide.code, 'invalid_offer_intents');

  const unknown = validateInterests(['ai-ml', 'quantum-teleportation']);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.code, 'invalid_interests');
    assert.match(unknown.message, /catalogue|Did you mean/);
  }
  assert.equal(validateNeedIntents('seeking-cofounder').ok, false);
  assert.equal(MAX_NEED_INTENTS, 3);
  assert.equal(MAX_OFFER_INTENTS, 3);
});

test('validators: interests enforce the catalogue and MAX_INTERESTS', () => {
  assert.deepEqual(validateInterests(['ai-ml', 'startups']), { ok: true, value: ['ai-ml', 'startups'] });
  assert.deepEqual(validateInterests(['AI', 'Стартапы']), { ok: true, value: ['ai-ml', 'startups'] });
  const six = validateInterests(['ai-ml', 'saas', 'dev-tools', 'automation', 'data-analytics', 'cybersecurity']);
  assert.equal(six.ok, false);
  assert.equal(MAX_INTERESTS, 5);
  assert.deepEqual(validateInterests(undefined), { ok: true, value: [] });
});

test('validators: keywords — MAX_KEYWORDS, length cap, normalization', () => {
  assert.deepEqual(validateKeywords([' ФудТех ', 'фудтех', 'B2B']), { ok: true, value: ['фудтех', 'b2b'] });
  assert.equal(validateKeywords(['x'.repeat(41)]).ok, false);
  assert.equal(validateKeywords(['a', 'b', 'c', 'd', 'e', 'f']).ok, false);
  assert.equal(MAX_KEYWORD_LENGTH, 40);
  assert.equal(MAX_KEYWORDS, 5);
  assert.equal(validateKeywords(['ok', 7]).ok, false);
});

test('validators: job_function / industry accept prefer-not-to-say → null', () => {
  assert.deepEqual(validateJobFunction('founder-ceo'), { ok: true, value: 'founder-ceo' });
  assert.deepEqual(validateJobFunction(PREFER_NOT_TO_SAY), { ok: true, value: null });
  assert.deepEqual(validateJobFunction(null), { ok: true, value: null });
  assert.equal(validateJobFunction('astronaut').ok, false);
  assert.deepEqual(validateIndustry('ai-saas'), { ok: true, value: 'ai-saas' });
  assert.deepEqual(validateIndustry(''), { ok: true, value: null });
  assert.equal(validateIndustry('intergalactic').ok, false);
});

// ---------------------------------------------------------------------------
// Public payload
// ---------------------------------------------------------------------------

test('taxonomyPayload: shaped for GET /api/taxonomy with both locales at once', () => {
  const payload = taxonomyPayload() as {
    version: string;
    limits: Record<string, number>;
    intents: { id: string; need: { id: string; label: Record<string, string> }; offer: { id: string } }[];
    interests: { id: string; group: string; label: Record<string, string> }[];
    interest_groups: { id: string }[];
    functions: unknown[];
    industries: unknown[];
  };
  assert.equal(payload.version, 'v3');
  assert.equal(payload.intents.length, 16);
  assert.equal(payload.interests.length, INTERESTS.length);
  assert.equal(payload.interest_groups.length, INTEREST_GROUPS.length);
  assert.equal(payload.functions.length, 14);
  assert.equal(payload.industries.length, 12);
  assert.equal(payload.limits.interests, MAX_INTERESTS);
  assert.ok(payload.intents[0]!.need.label.ru && payload.intents[0]!.need.label.en);
});

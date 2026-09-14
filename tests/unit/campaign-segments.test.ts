import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  audienceFilterIsEmpty,
  emptyAudienceFilter,
  normalizeAudienceFilter,
  validateAudienceFilter,
  validateCampaignCreate,
  validateCampaignEdit,
} from '../../src/domain/campaigns';

/**
 * Campaign audience segments: validation + normalization. The SQL effect of the
 * filter (which members are selected) is covered by the integration suite; here
 * the CONTRACT is pinned — catalogue-only ids, additive keys, empty = everyone.
 */

const EVENT = '11111111-1111-4111-8111-111111111111';

test('audience filter: an empty object constrains nothing', () => {
  const parsed = validateAudienceFilter({});
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, emptyAudienceFilter());
  assert.equal(audienceFilterIsEmpty(parsed.value), true);
});

test('audience filter: absent axes default to "no constraint"', () => {
  const parsed = validateAudienceFilter({ interests: ['ai-ml'] });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.interests, ['ai-ml']);
  assert.deepEqual(parsed.value.need_intents, []);
  assert.equal(parsed.value.job_function, null);
  assert.equal(audienceFilterIsEmpty(parsed.value), false);
});

test('audience filter: catalogue ids only, deduped', () => {
  const parsed = validateAudienceFilter({
    need_intents: ['seeking-cofounder', 'seeking-cofounder'],
    offer_intents: ['open-to-cofound'],
    interests: ['ai-ml', 'dev-tools'],
    job_function: 'engineering',
    industry: 'ai-saas',
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.need_intents, ['seeking-cofounder']);
  assert.deepEqual(parsed.value.interests, ['ai-ml', 'dev-tools']);
  assert.equal(parsed.value.job_function, 'engineering');
  assert.equal(parsed.value.industry, 'ai-saas');
});

test('audience filter: unknown ids are rejected, never silently ignored', () => {
  // A typo must never WIDEN a send: an id outside the catalogue is a 400.
  const bad = validateAudienceFilter({ interests: ['not-a-topic'] });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'invalid_interests');
  assert.equal(validateAudienceFilter({ need_intents: ['open-to-cofound'] }).ok, false, 'need axis takes need ids only');
  assert.equal(validateAudienceFilter({ job_function: 'ceo' }).ok, false);
  assert.equal(validateAudienceFilter({ industry: 'crypto' }).ok, false);
});

test('audience filter: wrong shapes are rejected', () => {
  assert.equal(validateAudienceFilter(null).ok, false);
  assert.equal(validateAudienceFilter([]).ok, false);
  assert.equal(validateAudienceFilter('ai-ml').ok, false);
  assert.equal(validateAudienceFilter({ interests: 'ai-ml' }).ok, false);
  assert.equal(validateAudienceFilter({ job_function: 42 }).ok, false);
});

test('audience filter: prefer-not-to-say and blank facets mean "no constraint"', () => {
  const parsed = validateAudienceFilter({ job_function: 'prefer-not-to-say', industry: '   ' });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.job_function, null);
  assert.equal(parsed.value.industry, null);
  assert.equal(audienceFilterIsEmpty(parsed.value), true);
});

test('audience filter: unknown keys are preserved (additive registry)', () => {
  const parsed = validateAudienceFilter({ interests: ['ai-ml'], future_axis: ['x'] });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value['future_axis'], ['x']);
});

test('audience filter: normalizeAudienceFilter degrades a broken stored row to "everyone"', () => {
  // Defensive read path: a hand-edited or older jsonb value must never 500 the
  // audience endpoint; it degrades to the unsegmented audience.
  assert.deepEqual(normalizeAudienceFilter({ interests: ['nope'] }), emptyAudienceFilter());
  assert.deepEqual(normalizeAudienceFilter(null), emptyAudienceFilter());
  assert.deepEqual(normalizeAudienceFilter('junk'), emptyAudienceFilter());
  assert.deepEqual(normalizeAudienceFilter({ industry: 'fintech' }).industry, 'fintech');
});

test('campaign create: accepts an optional segment and defaults to none', () => {
  const plain = validateCampaignCreate({ event_id: EVENT, purpose: 'service_channel', body_text: 'x' });
  assert.equal(plain.ok, true);
  if (plain.ok) assert.equal(audienceFilterIsEmpty(plain.value.audienceFilter), true);

  const segmented = validateCampaignCreate({
    event_id: EVENT,
    purpose: 'organizer_marketing',
    body_text: 'x',
    audience_filter: { interests: ['ai-ml'] },
  });
  assert.equal(segmented.ok, true);
  if (segmented.ok) assert.deepEqual(segmented.value.audienceFilter.interests, ['ai-ml']);

  const bad = validateCampaignCreate({
    event_id: EVENT,
    purpose: 'organizer_marketing',
    body_text: 'x',
    audience_filter: { interests: ['nope'] },
  });
  assert.equal(bad.ok, false);
});

test('campaign edit: the segment is validated, existing permissive shapes still pass', () => {
  // The pre-segment contract (any object ≤ 4096 bytes) stays valid: the registry
  // is additive, so an unknown key is carried, not rejected.
  assert.equal(validateCampaignEdit({ audience_filter: { tag: ['a'] } }).ok, true);
  assert.equal(validateCampaignEdit({ audience_filter: [] }).ok, false);
  assert.equal(validateCampaignEdit({ audience_filter: { industry: 'nope' } }).ok, false);
  const ok = validateCampaignEdit({ audience_filter: { need_intents: ['hiring'], industry: 'fintech' } });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.audienceFilter?.industry, 'fintech');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addKeyword,
  filterChips,
  groupChips,
  intentGoal,
  itemsFor,
  labelFor,
  labelsForIds,
  limitFor,
  parseCatalog,
  reasonLabelOf,
  toggleSelection,
  type ChipItem,
  type TaxonomyCatalog,
} from '../../src/domain/picker';
import { taxonomyPayload } from '../../src/domain/taxonomy';

/** The real catalogue — the picker must work against the shipped payload. */
const CATALOG = parseCatalog(taxonomyPayload())!;

test('picker: the shipped catalogue parses and carries the enforced limits', () => {
  assert.ok(CATALOG);
  assert.equal(CATALOG.version, 'v3');
  assert.equal(limitFor(CATALOG, 'need_intents'), 3);
  assert.equal(limitFor(CATALOG, 'offer_intents'), 3);
  assert.equal(limitFor(CATALOG, 'interests'), 5);
  assert.equal(CATALOG.limits.keywords, 5);
  assert.equal(CATALOG.limits.keyword_length, 40);
  assert.equal(CATALOG.functions.length, 14);
  assert.equal(CATALOG.industries.length, 12);
});

test('picker: parseCatalog rejects unusable payloads instead of half-rendering', () => {
  assert.equal(parseCatalog(null), null);
  assert.equal(parseCatalog('v3'), null);
  assert.equal(parseCatalog({}), null);
  // wrong version
  assert.equal(parseCatalog({ ...taxonomyPayload(), version: 'v2' }), null);
  // missing limits
  const withoutLimits = { ...(taxonomyPayload() as Record<string, unknown>) };
  delete withoutLimits['limits'];
  assert.equal(parseCatalog(withoutLimits), null);
  assert.equal(parseCatalog({ ...taxonomyPayload(), limits: { need_intents: 3 } }), null);
  // missing a list
  assert.equal(parseCatalog({ ...taxonomyPayload(), interests: undefined }), null);
  assert.ok(parseCatalog(taxonomyPayload()));
});

test('picker: intent sides expose both the chip label and the reason goal', () => {
  const payload = taxonomyPayload() as { intents: { need: { id: string; label: unknown; goal: unknown } }[] };
  assert.ok(payload.intents.every((pair) => pair.need.label && pair.need.goal));
  // The goal is what the reason template interpolates ("co-founder"), not the
  // chip text ("Looking for a co-founder").
  const goal = intentGoal(CATALOG, 'need', 'seeking-cofounder', 'en');
  const label = itemsFor(CATALOG, 'need_intents', 'en').find((i) => i.id === 'seeking-cofounder')?.label;
  assert.ok(goal.length > 0);
  assert.notEqual(goal, label);
  assert.match(goal, /co-founder/i);
});

test('picker: limits are per axis and never silently exceeded', () => {
  let value: string[] = [];
  const needs = itemsFor(CATALOG, 'need_intents', 'en').map((i) => i.id);
  for (const id of needs.slice(0, 3)) {
    const result = toggleSelection(value, id, 3);
    assert.equal(result.ok, true);
    if (result.ok) value = result.next;
  }
  assert.equal(value.length, 3);
  const rejected = toggleSelection(value, needs[3]!, 3);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.reason, 'limit');

  // Deselecting is always allowed — even for a value that exceeds the limit
  // (a shrunken catalogue must stay editable).
  const over = ['a', 'b', 'c', 'd'];
  const removed = toggleSelection(over, 'd', 3);
  assert.equal(removed.ok, true);
  if (removed.ok) assert.deepEqual(removed.next, ['a', 'b', 'c']);
});

test('picker: toggle is idempotent per id and preserves order', () => {
  const first = toggleSelection([], 'ai-ml', 5);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = toggleSelection(first.next, 'saas', 5);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.next, ['ai-ml', 'saas']);
  const off = toggleSelection(second.next, 'ai-ml', 5);
  assert.equal(off.ok, true);
  if (off.ok) assert.deepEqual(off.next, ['saas']);
});

test('picker: keywords normalize like the API and enforce both limits', () => {
  let value: string[] = [];
  const added = addKeyword(value, '  FoodTech  ', 5, 40);
  assert.equal(added.ok, true);
  if (added.ok) value = added.next;
  assert.deepEqual(value, ['foodtech']);
  // duplicates are a no-op, not an error
  const duplicate = addKeyword(value, 'FOODTECH', 5, 40);
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) assert.deepEqual(duplicate.next, ['foodtech']);
  // blank input is ignored
  const blank = addKeyword(value, '   ', 5, 40);
  assert.equal(blank.ok, true);
  if (blank.ok) assert.deepEqual(blank.next, ['foodtech']);
  // length limit
  const tooLong = addKeyword(value, 'x'.repeat(41), 5, 40);
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.reason, 'too_long');
  assert.equal(addKeyword(value, 'x'.repeat(40), 5, 40).ok, true);
  // count limit
  const full = ['a', 'b', 'c', 'd', 'e'];
  const overflow = addKeyword(full, 'f', 5, 40);
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.equal(overflow.reason, 'limit');
});

test('picker: chip search matches labels and ids, case-insensitively', () => {
  const items: ChipItem[] = [
    { id: 'ai-ml', label: 'AI и ML' },
    { id: 'startups', label: 'Стартапы' },
    { id: 'beauty-industry', label: 'Индустрия красоты' },
  ];
  assert.equal(filterChips(items, '').length, 3);
  assert.deepEqual(filterChips(items, 'ai-ml').map((i) => i.id), ['ai-ml']);
  assert.deepEqual(filterChips(items, 'СТАРТ').map((i) => i.id), ['startups']);
  assert.deepEqual(filterChips(items, 'красот').map((i) => i.id), ['beauty-industry']);
  assert.deepEqual(filterChips(items, 'nope'), []);
});

test('picker: interests are grouped, and an empty group disappears while searching', () => {
  const groups = groupChips(CATALOG, 'en', '');
  assert.ok(groups.length > 0);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, CATALOG.interests.length);
  assert.ok(groups.every((g) => g.label.length > 0 && g.items.length > 0));

  const filtered = groupChips(CATALOG, 'en', 'skincare');
  assert.ok(filtered.length >= 1 && filtered.length < groups.length);
  assert.ok(filtered.every((g) => g.items.every((i) => i.label.toLowerCase().includes('skincare') || i.id.includes('skincare'))));
});

test('picker: labels fall back to EN for a locale the catalogue does not carry', () => {
  const interest = CATALOG.interests[0]!;
  assert.equal(labelFor(interest.label, 'ru'), interest.label.ru);
  assert.equal(labelFor(interest.label, 'en'), interest.label.en);
  // es has no catalogue labels — documented EN fallback, never an empty chip
  assert.equal(labelFor(interest.label, 'es'), interest.label.en);
  assert.equal(labelFor(undefined, 'es'), '');
});

test('picker: stored ids resolve to labels, unknown ids degrade to the raw id', () => {
  const labels = labelsForIds(CATALOG, 'interests', ['ai-ml', 'not-a-real-interest'], 'en');
  assert.equal(labels[0], labelFor(CATALOG.interests.find((i) => i.id === 'ai-ml')!.label, 'en'));
  assert.equal(labels[1], 'not-a-real-interest');

  const intents = labelsForIds(CATALOG, 'need_intents', ['seeking-cofounder'], 'en');
  assert.match(intents[0]!, /co-founder/i);
});

test('picker: reason labels resolve need goals, interests, functions and industries', () => {
  const labelOf = reasonLabelOf(CATALOG, 'en');
  assert.match(labelOf('need', 'seeking-cofounder'), /co-founder/i);
  assert.equal(labelOf('interest', 'ai-ml'), labelFor(CATALOG.interests.find((i) => i.id === 'ai-ml')!.label, 'en'));
  assert.equal(labelOf('function', 'founder-ceo'), labelFor(CATALOG.functions.find((f) => f.id === 'founder-ceo')!.label, 'en'));
  assert.equal(labelOf('industry', 'ai-saas'), labelFor(CATALOG.industries.find((i) => i.id === 'ai-saas')!.label, 'en'));
  // stale id: the sentence keeps the id rather than losing the reason
  assert.equal(labelOf('interest', 'gone'), 'gone');
});

test('picker: itemsFor returns every catalogue entry in catalogue order', () => {
  const interests = itemsFor(CATALOG, 'interests', 'en');
  assert.equal(interests.length, CATALOG.interests.length);
  assert.deepEqual(
    interests.map((i) => i.id),
    CATALOG.interests.map((i) => i.id),
  );
  assert.ok(interests.every((i) => typeof i.group === 'string'));

  const offers = itemsFor(CATALOG, 'offer_intents', 'ru');
  assert.equal(offers.length, CATALOG.intents.length);
  assert.ok(offers.every((i) => i.group === undefined));
});

/** A minimal hand-built catalogue for the edge cases above. */
export const MINIMAL_CATALOG: TaxonomyCatalog = {
  version: 'v3',
  limits: { need_intents: 3, offer_intents: 3, interests: 5, keywords: 5, keyword_length: 40 },
  intents: [],
  interests: [],
  interest_groups: [],
  functions: [],
  industries: [],
  prefer_not_to_say: 'prefer-not-to-say',
};

test('picker: an empty catalogue degrades gracefully (no throw, empty lists)', () => {
  assert.deepEqual(itemsFor(MINIMAL_CATALOG, 'interests', 'en'), []);
  assert.deepEqual(groupChips(MINIMAL_CATALOG, 'en', ''), []);
  assert.deepEqual(labelsForIds(MINIMAL_CATALOG, 'need_intents', ['seeking-cofounder'], 'en'), ['seeking-cofounder']);
});

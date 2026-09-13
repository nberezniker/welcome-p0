import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_DRAFT_VALUES,
  ONBOARDING_DRAFT_VERSION,
  ONBOARDING_DRAFT_KEY,
  ONBOARDING_STEPS,
  emptyDraft,
  hiddenFromPublish,
  parseDraft,
  serializeDraft,
} from '../../src/domain/onboarding-draft';
import {
  DEFAULT_DIRECTORY_MODE,
  EMPTY_DIRECTORY_FILTERS,
  filtersFromQuery,
  filtersToApiQuery,
  filtersToQuery,
  hasActiveFilters,
} from '../../src/domain/directory-filters';

// ---------------------------------------------------------------------------
// Onboarding draft (localStorage)
// ---------------------------------------------------------------------------

test('draft: an empty draft is versioned, starts at step 1 and hides nothing', () => {
  const draft = emptyDraft();
  assert.equal(draft.version, ONBOARDING_DRAFT_VERSION);
  assert.equal(draft.step, 1);
  assert.deepEqual(draft.values, EMPTY_DRAFT_VALUES);
  assert.deepEqual(draft.links, {});
  assert.deepEqual(draft.hidden_fields, []);
  assert.equal(ONBOARDING_STEPS, 4);
  assert.match(ONBOARDING_DRAFT_KEY, /^welcome\.onboarding\.draft\.v\d+$/);
});

test('draft: serialize → parse is lossless for every wizard field', () => {
  const values = {
    display_name: 'Никита',
    headline: 'Founder',
    company: 'WELCOME',
    short_bio: 'Строю нетворкинг',
    languages: ['ru', 'en', 'es'],
    job_function: 'founder-ceo',
    industry: 'ai-saas',
    need_intents: ['seeking-cofounder', 'seeking-investment'],
    offer_intents: ['open-to-cofound'],
    interests: ['ai-ml', 'startups'],
    keywords: ['фудтех'],
  };
  const links = { linkedin_url: 'https://linkedin.com/in/x', github_url: 'https://github.com/x' };
  const raw = serializeDraft({ step: 3, values, links, hidden_fields: ['short_bio'] });
  const parsed = parseDraft(raw);
  assert.ok(parsed);
  assert.equal(parsed.step, 3);
  assert.deepEqual(parsed.values, values);
  assert.deepEqual(parsed.links, links);
  assert.deepEqual(parsed.hidden_fields, ['short_bio']);
  assert.match(parsed.saved_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('draft: parseDraft accepts an object too and never throws on junk', () => {
  const parsed = parseDraft({ version: ONBOARDING_DRAFT_VERSION, step: 2, values: { display_name: 'A' } });
  assert.ok(parsed);
  assert.equal(parsed.values.display_name, 'A');
  assert.deepEqual(parsed.values.interests, []);
  for (const junk of [null, undefined, 42, 'not json', '[]', '{}', { version: 99 }, { version: 1, step: 'x' }]) {
    assert.equal(parseDraft(junk), null, `${JSON.stringify(junk)} must be rejected`);
  }
});

test('draft: a draft from another version is discarded, never half-read', () => {
  const raw = JSON.stringify({ ...emptyDraft(), version: ONBOARDING_DRAFT_VERSION + 1 });
  assert.equal(parseDraft(raw), null);
});

test('draft: the step is clamped into range and unknown links/kinds are dropped', () => {
  const clamped = parseDraft({
    version: ONBOARDING_DRAFT_VERSION,
    step: 99,
    values: { display_name: 'A' },
    links: { linkedin_url: 'https://linkedin.com/in/x', evil_kind: 'https://evil.example' },
  });
  assert.ok(clamped);
  assert.equal(clamped.step, ONBOARDING_STEPS);
  assert.deepEqual(Object.keys(clamped.links), ['linkedin_url']);

  const below = parseDraft({ version: ONBOARDING_DRAFT_VERSION, step: -3, values: {} });
  assert.equal(below?.step, 1);
});

test('draft: over-long lists are truncated to the catalogue limits', () => {
  const parsed = parseDraft({
    version: ONBOARDING_DRAFT_VERSION,
    step: 1,
    values: {
      display_name: 'A',
      interests: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      need_intents: ['n1', 'n2', 'n3', 'n4'],
      offer_intents: ['o1', 'o2', 'o3', 'o4'],
      keywords: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'],
      languages: Array.from({ length: 15 }, (_, i) => `l${i}`),
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.values.interests.length, 5);
  assert.equal(parsed.values.need_intents.length, 3);
  assert.equal(parsed.values.offer_intents.length, 3);
  assert.equal(parsed.values.keywords.length, 5);
  assert.equal(parsed.values.languages.length, 10);
});

test('draft: publish checkboxes invert into the hidden_fields deny list', () => {
  const publish = { headline: true, company: false, short_bio: true, keywords: false };
  assert.deepEqual(hiddenFromPublish(publish).sort(), ['company', 'keywords']);
  assert.deepEqual(hiddenFromPublish({ headline: true }), []);
  assert.deepEqual(hiddenFromPublish({}), []);
});

// ---------------------------------------------------------------------------
// Directory filters ↔ URL
// ---------------------------------------------------------------------------

test('directory filters: the default is intent mode with nothing narrowed', () => {
  assert.equal(DEFAULT_DIRECTORY_MODE, 'intent');
  assert.deepEqual(filtersFromQuery({}), EMPTY_DIRECTORY_FILTERS);
  assert.equal(filtersToQuery(EMPTY_DIRECTORY_FILTERS), 'mode=intent');
  assert.equal(hasActiveFilters(EMPTY_DIRECTORY_FILTERS), false);
});

test('directory filters: query round-trips through the URL contract', () => {
  const filters = {
    mode: 'interest' as const,
    interest: 'ai-ml',
    jobFunction: 'founder-ceo',
    industry: 'ai-saas',
    q: 'acme',
  };
  const query = filtersToQuery(filters);
  assert.deepEqual(
    [...new URLSearchParams(query).keys()].sort(),
    ['function', 'industry', 'interest', 'mode', 'q'].sort(),
  );
  const params = new URLSearchParams(query);
  const back = filtersFromQuery({
    mode: params.get('mode') ?? undefined,
    interest: params.get('interest') ?? undefined,
    function: params.get('function') ?? undefined,
    industry: params.get('industry') ?? undefined,
    q: params.get('q') ?? undefined,
  });
  assert.deepEqual(back, filters);
  assert.equal(hasActiveFilters(back), true);
});

test('directory filters: the API query uses the canonical job_function param', () => {
  const api = new URLSearchParams(
    filtersToApiQuery({ mode: 'all', interest: null, jobFunction: 'product', industry: null, q: '' }),
  );
  assert.equal(api.get('job_function'), 'product');
  assert.equal(api.get('function'), null);
  assert.equal(api.get('mode'), 'all');
  assert.equal(api.get('interest'), null);
});

test('directory filters: invalid modes fall back and blank values are omitted', () => {
  assert.equal(filtersFromQuery({ mode: 'telepathy' }).mode, DEFAULT_DIRECTORY_MODE);
  const query = filtersToQuery({ ...EMPTY_DIRECTORY_FILTERS, mode: 'all', q: '   ' });
  assert.equal(query, 'mode=all');
  // whitespace-only search is not an active filter
  assert.equal(hasActiveFilters({ ...EMPTY_DIRECTORY_FILTERS, q: '  ' }), false);
  const trimmed = new URLSearchParams(filtersToQuery({ ...EMPTY_DIRECTORY_FILTERS, q: ' acme ' }));
  assert.equal(trimmed.get('q'), 'acme');
});

test('directory filters: all three modes serialize and survive the round trip', () => {
  for (const mode of ['intent', 'interest', 'all'] as const) {
    const filters = { ...EMPTY_DIRECTORY_FILTERS, mode };
    const params = new URLSearchParams(filtersToQuery(filters));
    const back = filtersFromQuery({ mode: params.get('mode') ?? undefined });
    assert.equal(back.mode, mode);
  }
});

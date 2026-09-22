import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DIRECTORY_MODE,
  defaultModeFor,
  filtersFromQuery,
} from '../../src/domain/directory-filters';
import { complementOf } from '../../src/domain/taxonomy';

/**
 * The directory's default mode is a PRODUCT decision with one exception, and
 * this file pins both halves of it.
 *
 * `intent` ("they seek what I offer") is the view the product is differentiated
 * by, so it is the default wherever it can produce anything. It cannot when the
 * API's own filter is empty by construction — the API derives it from
 * `complementOf(viewer.offer_intents)` — and ONLY then does the page open on
 * `all`. The distinction this test exists to keep is that between "empty because
 * nobody matches (a finding about the event)" and "empty because there is nothing
 * to look for (arithmetic)": the first must keep the narrowed view, the second
 * must not.
 */

test('directory default mode: intent stays the default wherever it can produce something', () => {
  assert.equal(DEFAULT_DIRECTORY_MODE, 'intent');
  assert.equal(defaultModeFor(true), 'intent');
});

test('directory default mode: only an impossible intent filter falls back to all', () => {
  assert.equal(defaultModeFor(false), 'all');
});

test('directory default mode: the exception is exactly "no offer has a complement"', () => {
  // The condition the page evaluates, spelled out against the real catalogue:
  // a viewer with at least one complementable offer gets `intent`, a viewer with
  // none does not. This is what keeps the page from disagreeing with the API,
  // which builds the same filter from the same values.
  const intentPossible = (offers: string[]) => offers.some((offer) => complementOf(offer) !== null);

  assert.equal(defaultModeFor(intentPossible([])), 'all', 'no offers at all ⇒ nothing to look for');
  assert.equal(
    defaultModeFor(intentPossible(['not-a-real-intent-id'])),
    'all',
    'values the catalogue has no complement for ⇒ still nothing to look for',
  );
  assert.equal(defaultModeFor(intentPossible(['mentoring'])), 'intent', 'mentoring has a complement');
  assert.equal(
    defaultModeFor(intentPossible(['not-a-real-intent-id', 'mentoring'])),
    'intent',
    'one usable offer is enough',
  );
});

test('directory default mode: filters parsed from a query honour the caller fallback', () => {
  // No `mode` in the URL ⇒ the caller's fallback decides.
  assert.equal(filtersFromQuery({}, 'all').mode, 'all');
  assert.equal(filtersFromQuery({}, 'intent').mode, 'intent');
  // ...and an EXPLICIT mode always wins over it, in both directions: a link that
  // names a mode must reopen in that mode, even for a viewer the fallback would
  // have sent elsewhere.
  assert.equal(filtersFromQuery({ mode: 'intent' }, 'all').mode, 'intent');
  assert.equal(filtersFromQuery({ mode: 'all' }, 'intent').mode, 'all');
  assert.equal(filtersFromQuery({ mode: 'interest' }, 'all').mode, 'interest');
  // An unknown value is not an explicit mode: it falls back like an absent one.
  assert.equal(filtersFromQuery({ mode: 'telepathy' }, 'all').mode, 'all');
  // The default parameter preserves the documented product default.
  assert.equal(filtersFromQuery({}).mode, DEFAULT_DIRECTORY_MODE);
});

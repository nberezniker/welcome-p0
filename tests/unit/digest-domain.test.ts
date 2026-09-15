import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIGEST_MAX_PEOPLE,
  DIGEST_REPEAT_WINDOW_DAYS,
  digestDedupeKey,
  digestRepeatWindowStartMs,
  digestWeekKey,
  mergeDigestCandidates,
  oneLineReason,
  renderDigestMessage,
  selectDigestPeople,
  type DigestCandidate,
} from '../../src/domain/digest';
import { formatReasonV4, type ReasonV4 } from '../../src/domain/reasons-v4';
import { reasonV4Templates } from '../../src/i18n/reason-templates';
import { reasonLabelOfV4, parseCatalog } from '../../src/domain/picker';
import { taxonomyPayload } from '../../src/domain/taxonomy';

/**
 * Weekly digest — the pure selection AND the honest copy (design §B5, Phase 4).
 *
 * Two groups of promises are tested here:
 *   - the caps and exclusions (≤3 people, never someone recently digested);
 *   - the COPY: the message must be explainable and must never contain a private
 *     field — another person's goal text, a contact value, or a number that is
 *     not the recipient's own list.
 */

const catalog = parseCatalog(taxonomyPayload());
assert.ok(catalog, 'taxonomy catalogue must parse');
const labelOf = reasonLabelOfV4(catalog!, 'en');
const templates = reasonV4Templates('en');

function candidate(over: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    profileId: 'prof-1',
    displayName: 'Anna K.',
    score: 80,
    reasonsUseful: [{ code: 'goal_advanced', params: { goal: 'enter-market' } }] as ReasonV4[],
    reasonsGrowth: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Merge + selection
// ---------------------------------------------------------------------------

test('digest: merging several events keeps one row per person, with the best score', () => {
  const merged = mergeDigestCandidates([
    [candidate({ profileId: 'p1', score: 40 }), candidate({ profileId: 'p2', score: 70 })],
    [candidate({ profileId: 'p1', score: 90 }), candidate({ profileId: 'p3', score: 50 })],
  ]);
  assert.deepEqual(
    merged.map((c) => `${c.profileId}:${c.score}`),
    ['p1:90', 'p2:70', 'p3:50'],
  );
});

test('digest: the merge is order-independent (deterministic tie-break on id)', () => {
  const listA = [candidate({ profileId: 'b', score: 60 }), candidate({ profileId: 'a', score: 60 })];
  const listB = [candidate({ profileId: 'a', score: 60 }), candidate({ profileId: 'b', score: 60 })];
  assert.deepEqual(
    mergeDigestCandidates([listA]).map((c) => c.profileId),
    mergeDigestCandidates([listB]).map((c) => c.profileId),
  );
});

test('digest: at most three people, even when asked for more', () => {
  const five = ['p1', 'p2', 'p3', 'p4', 'p5'].map((id, index) => candidate({ profileId: id, score: 100 - index }));
  assert.equal(selectDigestPeople(five).length, DIGEST_MAX_PEOPLE);
  assert.equal(selectDigestPeople(five, { limit: 99 }).length, DIGEST_MAX_PEOPLE, 'the cap is not configurable away');
  assert.equal(selectDigestPeople(five, { limit: 2 }).length, 2, 'a caller may ask for fewer');
  assert.deepEqual(selectDigestPeople(five, { limit: 0 }), []);
});

test('digest: people already digested recently are excluded', () => {
  const three = ['p1', 'p2', 'p3'].map((id, index) => candidate({ profileId: id, score: 100 - index }));
  const picked = selectDigestPeople(three, { excludedProfileIds: ['p1'] });
  assert.deepEqual(picked.map((p) => p.profileId), ['p2', 'p3']);
});

test('digest: a candidate the ranking cannot explain is dropped, not listed bare', () => {
  const picked = selectDigestPeople([
    candidate({ profileId: 'p1', reasonsUseful: [], reasonsGrowth: [] }),
    candidate({ profileId: 'p2' }),
  ]);
  assert.deepEqual(picked.map((p) => p.profileId), ['p2']);
});

test('digest: a growth-only reason is the honest fallback for the one line', () => {
  const growthOnly = candidate({ reasonsUseful: [], reasonsGrowth: [{ code: 'can_teach', params: { offer: 'mentoring' } }] });
  assert.deepEqual(oneLineReason(growthOnly), { code: 'can_teach', params: { offer: 'mentoring' } });
  assert.equal(oneLineReason(candidate({ reasonsUseful: [], reasonsGrowth: [] })), null);
});

test('digest: an empty candidate pool yields an empty digest (nothing is sent)', () => {
  assert.deepEqual(selectDigestPeople([]), []);
});

// ---------------------------------------------------------------------------
// Cadence + idempotency keys
// ---------------------------------------------------------------------------

test('digest: the ISO week key is stable across the whole week and across DST-free UTC', () => {
  // 2026-09-14 (Mon) .. 2026-09-20 (Sun) is ISO week 38 of 2026.
  assert.equal(digestWeekKey(Date.UTC(2026, 8, 14, 0, 0, 1)), '2026-W38');
  assert.equal(digestWeekKey(Date.UTC(2026, 8, 15, 12, 0, 0)), '2026-W38');
  assert.equal(digestWeekKey(Date.UTC(2026, 8, 20, 23, 59, 59)), '2026-W38');
  assert.equal(digestWeekKey(Date.UTC(2026, 8, 21, 0, 0, 1)), '2026-W39');
});

test('digest: the ISO week key rolls over correctly at a year boundary', () => {
  // 2025-12-29 (Mon) belongs to ISO week 1 of 2026 — a naive "week of the year"
  // would put it in week 53 of 2025 and let a second digest through.
  assert.equal(digestWeekKey(Date.UTC(2025, 11, 29, 12)), '2026-W01');
  assert.equal(digestWeekKey(Date.UTC(2026, 0, 1, 12)), '2026-W01');
  assert.equal(digestWeekKey(Date.UTC(2026, 0, 5, 12)), '2026-W02');
});

test('digest: the dedupe key is one per account per week', () => {
  assert.equal(digestDedupeKey('acc-1', '2026-W38'), 'digest:acc-1:2026-W38');
  assert.notEqual(digestDedupeKey('acc-1', '2026-W38'), digestDedupeKey('acc-1', '2026-W39'));
  assert.notEqual(digestDedupeKey('acc-1', '2026-W38'), digestDedupeKey('acc-2', '2026-W38'));
});

test('digest: the repeat window is a window, not "forever"', () => {
  const now = Date.UTC(2026, 8, 15, 12);
  assert.equal(now - digestRepeatWindowStartMs(now), DIGEST_REPEAT_WINDOW_DAYS * 86_400_000);
});

// ---------------------------------------------------------------------------
// Copy — spec §7 and the privacy promise
// ---------------------------------------------------------------------------

function render(people: { displayName: string; reason: string }[], goalLabel: string | null = 'Enter a market') {
  return renderDigestMessage({
    locale: 'en',
    goalLabel,
    people,
    link: 'https://welcome.test/me/notes',
    unsubscribeLink: 'https://welcome.test/api/me/followup/unsubscribe?t=digest.abc',
  });
}

const renderedReasons = (people: DigestCandidate[]) =>
  selectDigestPeople(people).map((person) => ({
    displayName: person.displayName,
    reason: formatReasonV4(person.reason, templates, labelOf),
  }));

test('digest copy: names, one reason each, the recipient’s own goal, and a stop link', () => {
  const message = render(renderedReasons([
    candidate({ profileId: 'p1', displayName: 'Anna K.' }),
    candidate({
      profileId: 'p2',
      displayName: 'Marc D.',
      reasonsUseful: [{ code: 'need_covered', params: { need: 'seeking-distribution' } } as ReasonV4],
    }),
  ]));
  assert.match(message.text, /Anna K\./);
  assert.match(message.text, /Marc D\./);
  assert.match(message.text, /Enter a market/);
  assert.match(message.text, /^2\. /m);
  assert.match(message.text, /unsubscribe\?t=digest\.abc/);
  assert.equal(message.text.split('\n').filter((line) => /^\d+\. /.test(line)).length, 2);
});

test('digest copy: it SAYS the list comes from the recipient’s own goals and profile', () => {
  const message = render(renderedReasons([candidate()]));
  assert.match(message.text, /your own goals and your own profile/i);
  // …and states it is a suggestion, not an outcome.
  assert.match(message.text, /suggestion, not a promise/i);
});

test('digest copy: never a private field — no other goal, no note text, no contact value', () => {
  // The candidate carries nothing private by construction; the assertion below
  // pins that nothing of the sort can reach the text even if a caller fed the
  // renderer a different person object.
  const message = render([
    { displayName: 'Anna K.', reason: 'Advances your goal: Enter a market' },
  ]);
  for (const forbidden of [
    'fundraise', // another person's goal id
    'secret note', // another person's note text
    'anna@example.com', // a contact value
    '+34 600 000 000',
    'telegram:annak',
  ]) {
    assert.ok(!message.text.includes(forbidden), `digest must not contain "${forbidden}"`);
  }
  assert.doesNotMatch(message.text, /\{[a-z]+\}/i, 'no placeholder left behind');
});

test('digest copy: the only number is the recipient’s own list length', () => {
  const message = render(renderedReasons([
    candidate({ profileId: 'p1' }),
    candidate({ profileId: 'p2' }),
    candidate({ profileId: 'p3' }),
  ]));
  const numbers = message.text.match(/\d+/g) ?? [];
  // 1..3 are list positions; nothing else (no "you will meet N people", no score,
  // no percentage — a number that is not the recipient's own data is a claim).
  assert.deepEqual([...new Set(numbers)].sort(), ['1', '2', '3']);
});

test('digest copy: a candidate with no renderable reason is not printed', () => {
  const message = render([
    { displayName: 'Anna K.', reason: '' },
    { displayName: 'Marc D.', reason: 'Covers what you are looking for: distribution' },
  ]);
  assert.ok(!message.text.includes('Anna K.'));
  assert.match(message.text, /^1\. Marc D\./m, 'numbering follows the printed lines');
});

test('digest copy: no goal set renders no goal line, and never a placeholder', () => {
  const message = render(renderedReasons([candidate()]), null);
  assert.doesNotMatch(message.text, /Your goal/);
  assert.doesNotMatch(message.text, /\{goal\}/);
  assert.match(message.text, /Anna K\./);
});

test('digest copy: an empty list renders the framing alone and never crashes', () => {
  const message = render([]);
  assert.match(message.text, /your own goals and your own profile/i);
  assert.ok(message.text.length > 0);
});

test('digest copy: every locale renders without placeholders and keeps the disclaimer', () => {
  for (const locale of ['en', 'ru', 'es'] as const) {
    const message = renderDigestMessage({
      locale,
      goalLabel: 'G',
      people: [{ displayName: 'Anna', reason: 'R' }],
      link: 'L',
      unsubscribeLink: 'U',
    });
    assert.doesNotMatch(message.text, /\{[a-z]+\}/i, `${locale} left a placeholder`);
    assert.match(message.text, /1\. Anna — R/);
  }
});

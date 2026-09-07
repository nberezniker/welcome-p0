import test from 'node:test';
import assert from 'node:assert/strict';
// The original spec baseline is imported directly (JS, no types — allowJs infers them).
import { normalTags as originalNormalTags, escapeVCard as originalEscapeVCard } from '../../spec/contracts/matching.mjs';
import { normalTags, escapeVCard } from '../../src/domain/matching';

// ---------------------------------------------------------------------------
// normalTags parity vs the original spec/contracts/matching.mjs
// ---------------------------------------------------------------------------

const tagCases: unknown[] = [
  [' Pilot ', 'pilot', ''],
  [],
  ['Design'],
  ['  design  ', 'DESIGN', 'de\u00A0sign'],
  ['a', 'b', 'a', 'b', 'c'],
  ['x'.repeat(80)],
  [''.repeat(0)],
  ['тег', 'ТЕГ ', ' Тег'],
  [' lead ', 'client', 'pilot'],
  ['123'],
  ['with,comma', 'with;semicolon'],
  ['tab\tsep'],
  ['multi\nline'],
];

test('normalTags parity: outputs match original on all cases', () => {
  for (const c of tagCases) {
    assert.deepEqual(normalTags(c), originalNormalTags(c));
  }
});

const tagThrowCases: unknown[] = [
  [12],
  ['ok', null],
  ['ok', 42],
  ['ok', { tag: 'x' }],
  ['ok', ['nested']],
  ['ok', undefined],
  ['x'.repeat(81)],
  ['y'.repeat(1000)],
];

test('normalTags parity: throws match original on all cases', () => {
  for (const c of tagThrowCases) {
    assert.throws(() => normalTags(c), TypeError);
    assert.throws(() => originalNormalTags(c), TypeError);
  }
});

test('normalTags parity: non-array inputs throw identically', () => {
  for (const c of ['x', 12, null, undefined, {}, true]) {
    assert.throws(() => normalTags(c), TypeError);
    assert.throws(() => originalNormalTags(c), TypeError);
  }
});

test('normalTags: spec archive case — normalize duplicates case whitespace', () => {
  assert.deepEqual(normalTags([' Pilot ', 'pilot', '']), ['pilot']);
});

test('normalTags: 80-char tag accepted, 81 rejected', () => {
  assert.deepEqual(normalTags(['x'.repeat(80)]), ['x'.repeat(80)]);
  assert.throws(() => normalTags(['x'.repeat(81)]), TypeError);
});

// ---------------------------------------------------------------------------
// escapeVCard parity vs the original (incl. the spec archive cases)
// ---------------------------------------------------------------------------

const vcardCases = [
  'A\r\nEMAIL:evil', // spec archive case
  'a,b;c\\d', // spec archive case
  '',
  'plain',
  'line1\nline2',
  'cr\ronly',
  'crlf\r\ntail\r\n',
  'back\\slash',
  'semi;colon,comma\\back',
  ';;,,\\\\',
  'имя Фамилия',
  'emoji 😀\nsecond',
  'N;ORG=tricky\\,still',
  ' multi  space ',
];

test('escapeVCard parity: outputs match original on all cases', () => {
  for (const c of vcardCases) {
    assert.equal(escapeVCard(c), originalEscapeVCard(c));
  }
});

test('escapeVCard: CRLF escaped (spec archive case)', () => {
  assert.equal(escapeVCard('A\r\nEMAIL:evil'), 'A\\nEMAIL:evil');
});

test('escapeVCard: delimiters escaped (spec archive case)', () => {
  assert.equal(escapeVCard('a,b;c\\d'), 'a\\,b\\;c\\\\d');
});

test('escapeVCard: escaping order — backslash never double-escapes produced sequences', () => {
  // Input ends with a literal backslash before a newline: \n must not become \\n + n
  assert.equal(escapeVCard('x\\\n'), 'x\\\\\\n');
  assert.equal(escapeVCard('x\\\n'), originalEscapeVCard('x\\\n'));
});

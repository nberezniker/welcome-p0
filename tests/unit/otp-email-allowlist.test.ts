import test from 'node:test';
import assert from 'node:assert/strict';
import { emailLookupHash, isEmailAllowlisted, parseEmailAllowlist } from '../../src/lib/crypto';

// ---------------------------------------------------------------------------
// ADR 0009 — staging-only dev-OTP allowlist primitive.
// The invariant under test: matching happens on the PEPPERED lookup hash (the
// raw target email never meets the raw list entries), normalization is
// forgiving of operator formatting, and the whole list is always scanned.
// ---------------------------------------------------------------------------

const PEPPER = 'unit-pepper-0123456789abcdef';

test('parseEmailAllowlist: trims, lowercases, drops empties and de-duplicates', () => {
  assert.deepEqual(parseEmailAllowlist(' A@B.io ,, b@c.io ,A@B.IO,   '), ['a@b.io', 'b@c.io']);
});

test('parseEmailAllowlist: empty / whitespace-only / comma-only input → []', () => {
  assert.deepEqual(parseEmailAllowlist(''), []);
  assert.deepEqual(parseEmailAllowlist('   '), []);
  assert.deepEqual(parseEmailAllowlist(',,,'), []);
});

test('parseEmailAllowlist: preserves order of first appearance', () => {
  assert.deepEqual(parseEmailAllowlist('z@x.io,a@x.io,z@x.io'), ['z@x.io', 'a@x.io']);
});

test('isEmailAllowlisted: exact membership match', () => {
  const hash = emailLookupHash('demo@welcome.test', PEPPER);
  assert.equal(isEmailAllowlisted(hash, 'demo@welcome.test', PEPPER), true);
});

test('isEmailAllowlisted: operator formatting (case, spaces) still matches', () => {
  const hash = emailLookupHash('demo@welcome.test', PEPPER);
  assert.equal(isEmailAllowlisted(hash, ' Demo@Welcome.Test , other@x.io ', PEPPER), true);
});

test('isEmailAllowlisted: a different address does NOT match', () => {
  const hash = emailLookupHash('real-user@example.org', PEPPER);
  assert.equal(isEmailAllowlisted(hash, 'demo@welcome.test,other@welcome.test', PEPPER), false);
});

test('isEmailAllowlisted: empty list never matches (switch alone exposes nothing)', () => {
  const hash = emailLookupHash('demo@welcome.test', PEPPER);
  assert.equal(isEmailAllowlisted(hash, '', PEPPER), false);
});

test('isEmailAllowlisted: a different pepper never matches the same address', () => {
  const hash = emailLookupHash('demo@welcome.test', PEPPER);
  assert.equal(isEmailAllowlisted(hash, 'demo@welcome.test', 'other-pepper-0123456789'), false);
});

test('isEmailAllowlisted: a match later in the list is still found (full scan, no early exit)', () => {
  const hash = emailLookupHash('last@welcome.test', PEPPER);
  const list = ['a@welcome.test', 'b@welcome.test', 'last@welcome.test'].join(',');
  assert.equal(isEmailAllowlisted(hash, list, PEPPER), true);
});

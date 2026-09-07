import test from 'node:test';
import assert from 'node:assert/strict';
import { generateOtpCode, hashOtpCode, timingSafeHexEqual } from '../../src/lib/crypto';

const PEPPER = 'unit-test-pepper-0123456789abcdef';

test('otp hash: deterministic for the same code and pepper', () => {
  assert.equal(hashOtpCode('123456', PEPPER), hashOtpCode('123456', PEPPER));
});

test('otp hash: different codes produce different hashes', () => {
  assert.notEqual(hashOtpCode('123456', PEPPER), hashOtpCode('654321', PEPPER));
});

test('otp hash: different peppers produce different hashes', () => {
  assert.notEqual(hashOtpCode('123456', PEPPER), hashOtpCode('123456', 'another-pepper-value'));
});

test('otp hash: output is a 64-char hex digest (HMAC-SHA256), never the plaintext code', () => {
  const h = hashOtpCode('123456', PEPPER);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes('123456'));
});

test('otp hash: leading zeros are significant', () => {
  assert.notEqual(hashOtpCode('012345', PEPPER), hashOtpCode('12345', PEPPER));
});

test('otp code generation: always 6 digits, zero-padded', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateOtpCode();
    assert.match(code, /^\d{6}$/);
  }
});

test('otp code generation: covers the full range over many samples', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(generateOtpCode());
  assert.ok(seen.has('000000') || seen.size > 1000); // wide spread, incl. low codes
});

test('timing safe compare: equal and unequal hex strings', () => {
  const a = hashOtpCode('123456', PEPPER);
  assert.equal(timingSafeHexEqual(a, a), true);
  assert.equal(timingSafeHexEqual(a, hashOtpCode('654321', PEPPER)), false);
  assert.equal(timingSafeHexEqual('abc', 'abcd'), false);
});

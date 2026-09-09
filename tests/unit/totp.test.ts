import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  otpauthUri,
  totpAt,
  verifyTotp,
} from '../../src/lib/totp';

// RFC 6238 Appendix B test vectors — secret is ASCII "12345678901234567890"
// (SHA1) / "12345678901234567890123456789012" (SHA256), 8-digit codes.
const SECRET_SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_SHA1_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1_111_111_109, '07081804'],
  [1_111_111_111, '14050471'],
  [1_234_567_890, '89005924'],
  [2_000_000_000, '69279037'],
  [20_000_000_000, '65353130'],
];
// 32 ASCII bytes → 52 unpadded base32 chars (asserted below).
const SECRET_SHA256 = base32Encode(Buffer.from('12345678901234567890123456789012', 'ascii'));
const RFC_SHA256_VECTORS: [number, string][] = [
  [59, '46119246'],
  [1_111_111_109, '68084774'],
  [1_111_111_111, '67062674'],
  [1_234_567_890, '91819424'],
  [2_000_000_000, '90698825'],
  [20_000_000_000, '77737706'],
];

test('totp: RFC 6238 SHA1 vectors (8 digits)', () => {
  for (const [tSeconds, expected] of RFC_SHA1_VECTORS) {
    assert.equal(
      totpAt(SECRET_SHA1, tSeconds * 1000, { algorithm: 'sha1', digits: 8 }),
      expected,
      `SHA1 vector at T=${tSeconds}`,
    );
  }
});

test('totp: RFC 6238 SHA256 vectors (8 digits)', () => {
  for (const [tSeconds, expected] of RFC_SHA256_VECTORS) {
    assert.equal(
      totpAt(SECRET_SHA256, tSeconds * 1000, { algorithm: 'sha256', digits: 8 }),
      expected,
      `SHA256 vector at T=${tSeconds}`,
    );
  }
});

test('totp: 6-digit code is the low 6 digits of the 8-digit value', () => {
  assert.equal(totpAt(SECRET_SHA1, 59_000, { digits: 6 }), '287082'); // 94287082
  assert.equal(totpAt(SECRET_SHA1, 1_111_111_109_000, { digits: 6 }), '081804'); // 07081804
});

test('totp: verify accepts the current code and ±1 step, rejects beyond', () => {
  const t0 = 1_700_000_000_000; // arbitrary moment inside a step
  const code = totpAt(SECRET_SHA1, t0);
  assert.equal(verifyTotp(SECRET_SHA1, code, t0), true);
  assert.equal(verifyTotp(SECRET_SHA1, code, t0 + 29_000), true); // same step
  assert.equal(verifyTotp(SECRET_SHA1, code, t0 + 31_000), true); // next step (±1 window)
  assert.equal(verifyTotp(SECRET_SHA1, code, t0 - 31_000), true); // previous step (±1 window)
  assert.equal(verifyTotp(SECRET_SHA1, code, t0 + 61_000), false); // 2 steps away
  assert.equal(verifyTotp(SECRET_SHA1, code, t0 - 61_000), false);
});

test('totp: verify rejects malformed and wrong codes', () => {
  const now = 1_700_000_000_000;
  assert.equal(verifyTotp(SECRET_SHA1, 'abcdef', now), false); // not digits
  assert.equal(verifyTotp(SECRET_SHA1, '12345', now), false); // wrong length
  assert.equal(verifyTotp(SECRET_SHA1, '', now), false); // empty
  assert.equal(verifyTotp(SECRET_SHA1, '000000', now), false); // wrong code (overridden below)
  // A deliberately wrong 6-digit code: flip one digit of the correct one.
  const code = totpAt(SECRET_SHA1, now);
  const wrong = code === '000000' ? '000001' : '000000';
  assert.equal(verifyTotp(SECRET_SHA1, wrong, now), false);
});

test('totp: generated secrets round-trip through base32', () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Encode(base32Decode(secret)), secret);
  // A fresh secret at the same time produces a 6-digit code that verifies.
  assert.equal(verifyTotp(secret, totpAt(secret, 123_456_789_000), 123_456_789_000), true);
});

test('base32: RFC 4648 vectors (unpadded)', () => {
  const cases: [string, string][] = [
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  for (const [plain, encoded] of cases) {
    assert.equal(base32Encode(Buffer.from(plain, 'utf8')), encoded);
    assert.equal(base32Decode(encoded).toString('utf8'), plain);
  }
  // Padding and whitespace are tolerated on decode.
  assert.equal(base32Decode('MZXW6YTBOI======').toString('utf8'), 'foobar');
  assert.equal(base32Decode('mzxw6 ytboi').toString('utf8'), 'foobar');
  assert.throws(() => base32Decode('abc1')); // '1' is outside the alphabet
});

test('recovery codes: shape, uniqueness, normalization and hashing', () => {
  const codes = generateRecoveryCodes(8);
  assert.equal(codes.length, 8);
  assert.ok(new Set(codes).size === 8, 'codes must be unique');
  for (const code of codes) {
    assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    // Independent SHA-256 of the canonical form (generated codes are uppercase
    // alphanumerics with one dash) — the persisted hash must match it.
    const expectedHash = createHash('sha256').update(code.replace('-', ''), 'utf8').digest('hex');
    assert.equal(hashRecoveryCode(code), expectedHash);
    assert.match(expectedHash, /^[0-9a-f]{64}$/);
  }
  // Normalization: separators/case are insignificant for hashing.
  const sample = codes[0]!;
  assert.equal(normalizeRecoveryCode(sample.toLowerCase().replace('-', ' ')), sample.replace('-', ''));
  assert.equal(hashRecoveryCode(sample.toLowerCase()), hashRecoveryCode(sample));
});

test('otpauth URI: spec F-03 format', () => {
  const uri = otpauthUri('user@example.org', SECRET_SHA1);
  assert.equal(
    uri,
    `otpauth://totp/WELCOME:user%40example.org?secret=${SECRET_SHA1}&issuer=WELCOME&algorithm=SHA1&digits=6&period=30`,
  );
});

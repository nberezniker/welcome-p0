import test from 'node:test';
import assert from 'node:assert/strict';
import { safeNextPath } from '../../src/lib/redirect';

// F-10: login ?next= validation. The WHATWG URL parser treats '\' as '/', so
// '/\evil.com' would navigate off-site — backslashes are rejected outright.

test('safeNextPath: plain in-app paths pass', () => {
  assert.equal(safeNextPath('/me'), '/me');
  assert.equal(safeNextPath('/me/profile'), '/me/profile');
  assert.equal(safeNextPath('/e/slug?tab=people'), '/e/slug?tab=people');
  assert.equal(safeNextPath('/'), '/');
});

test('safeNextPath: off-site and protocol-relative targets rejected', () => {
  assert.equal(safeNextPath('https://evil.example'), null);
  assert.equal(safeNextPath('http://evil.example/x'), null);
  assert.equal(safeNextPath('//evil.com'), null);
  assert.equal(safeNextPath('javascript:alert(1)'), null);
  assert.equal(safeNextPath('me'), null);
  assert.equal(safeNextPath(''), null);
});

test('safeNextPath: backslash bypasses are rejected (F-10)', () => {
  assert.equal(safeNextPath('/\\evil.com'), null, "WHATWG '\\/' → '//' bypass");
  assert.equal(safeNextPath('/me\\evil.com'), null);
  assert.equal(safeNextPath('\\evil.com'), null);
});

test('safeNextPath: non-strings rejected', () => {
  assert.equal(safeNextPath(null), null);
  assert.equal(safeNextPath(undefined), null);
  // @ts-expect-error — runtime guard for non-string input
  assert.equal(safeNextPath(42), null);
});

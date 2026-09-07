import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePublicSlug } from '../../src/lib/crypto';

const SLUG_RE = /^[A-Za-z0-9_-]{22}$/;

test('public slug: base64url alphabet, exactly 22 chars (>= 128-bit entropy)', () => {
  for (let i = 0; i < 200; i++) {
    const slug = generatePublicSlug();
    assert.match(slug, SLUG_RE);
  }
});

test('public slug: 2000 generations are unique (collision-free sample)', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(generatePublicSlug());
  assert.equal(seen.size, 2000);
});

test('public slug: decodes to 16 bytes (128 bits)', () => {
  const slug = generatePublicSlug();
  const bytes = Buffer.from(slug, 'base64url');
  assert.equal(bytes.length, 16);
});

test('public slug: satisfies the profiles CHECK (char_length >= 22)', () => {
  assert.ok(generatePublicSlug().length >= 22);
});

test('public slug: contains no URL-unsafe characters', () => {
  for (let i = 0; i < 100; i++) {
    const slug = generatePublicSlug();
    assert.equal(encodeURIComponent(slug), slug);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptValue, encryptValue } from '../../src/lib/crypto';

const KEY = Buffer.alloc(32, 11).toString('base64'); // 32 bytes — valid AES-256 key
const KEY2 = Buffer.alloc(32, 12).toString('base64');

test('aes-256-gcm: round-trips unicode, punctuation, and long values', () => {
  const values = [
    'a',
    '+7 900 000-00-00',
    'https://t.me/@some_user?x=1&y=2',
    'имя с пробелами и запятой, точкой',
    'emoji 🔐 and\ttabs\nnewlines',
    'x'.repeat(1000),
  ];
  for (const v of values) {
    assert.equal(decryptValue(encryptValue(v, KEY), KEY), v);
  }
});

test('aes-256-gcm: random IV — two encryptions of the same value differ', () => {
  const a = encryptValue('same', KEY);
  const b = encryptValue('same', KEY);
  assert.notEqual(a, b);
  assert.equal(decryptValue(a, KEY), 'same');
  assert.equal(decryptValue(b, KEY), 'same');
});

test('aes-256-gcm: ciphertext does not contain the plaintext', () => {
  const stored = encryptValue('super-secret-value', KEY);
  assert.ok(!stored.includes('super-secret-value'));
});

test('aes-256-gcm: tampered ciphertext fails authentication', () => {
  const payload = encryptValue('value', KEY);
  const parts = payload.split('.');
  const ct = Buffer.from(parts[2] as string, 'base64');
  ct[0] = (ct[0] ?? 0) ^ 0xff;
  const tampered = `${parts[0]}.${parts[1]}.${ct.toString('base64')}.${parts[3]}`;
  assert.throws(() => decryptValue(tampered, KEY));
});

test('aes-256-gcm: tampered auth tag fails authentication', () => {
  const payload = encryptValue('value', KEY);
  const parts = payload.split('.');
  const tag = Buffer.from(parts[3] as string, 'base64');
  tag[0] = (tag[0] ?? 0) ^ 0xff;
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${tag.toString('base64')}`;
  assert.throws(() => decryptValue(tampered, KEY));
});

test('aes-256-gcm: wrong key fails authentication', () => {
  const payload = encryptValue('value', KEY);
  assert.throws(() => decryptValue(payload, KEY2));
});

test('aes-256-gcm: malformed payloads are rejected', () => {
  assert.throws(() => decryptValue('garbage', KEY));
  assert.throws(() => decryptValue('v1.aaaa', KEY));
  assert.throws(() => decryptValue('v2.a.b.c', KEY));
});

test('aes-256-gcm: key must decode to exactly 32 bytes', () => {
  assert.throws(() => encryptValue('x', Buffer.alloc(16).toString('base64')));
  assert.throws(() => encryptValue('x', 'not-base64!!'));
});

test('aes-256-gcm: format is v1.<iv>.<ct>.<tag>', () => {
  const payload = encryptValue('value', KEY);
  const parts = payload.split('.');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  assert.equal(Buffer.from(parts[1] as string, 'base64').length, 12);
  assert.equal(Buffer.from(parts[3] as string, 'base64').length, 16);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalPair,
  eventContextKey,
  personalContextKey,
  validateCreateIntroInput,
  validateRespondInput,
  REVEAL_FIELDS,
} from '../../src/domain/introductions';

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';

test('canonical pair: lexicographic min/max, stable in both directions', () => {
  const ab = canonicalPair(A, B);
  const ba = canonicalPair(B, A);
  assert.deepEqual(ab, { profileA: A, profileB: B });
  assert.deepEqual(ba, { profileA: A, profileB: B });
});

test('context keys: event:<uuid> | personal:<min uuid> (interpretation ②)', () => {
  assert.equal(eventContextKey('e1e1e1e1-1111-4111-8111-111111111111'), 'event:e1e1e1e1-1111-4111-8111-111111111111');
  assert.equal(personalContextKey(A, B), `personal:${A}`);
  assert.equal(personalContextKey(B, A), `personal:${A}`);
});

test('reveal fields allowlist: contact kinds only, no email (login email is never stored)', () => {
  assert.deepEqual(REVEAL_FIELDS, ['whatsapp', 'telegram_username', 'linkedin_url', 'website', 'phone']);
});

test('validateCreateIntroInput: valid with event and reveal fields', () => {
  const r = validateCreateIntroInput({
    target_profile_id: B,
    event_id: 'e1e1e1e1-1111-4111-8111-111111111111',
    reveal_fields: ['whatsapp', 'phone'],
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.targetProfileId, B);
    assert.deepEqual(r.value.revealFields, ['whatsapp', 'phone']);
  }
});

test('validateCreateIntroInput: valid personal (no event), empty reveal fields default', () => {
  const r = validateCreateIntroInput({ target_profile_id: B });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.eventId, null);
    assert.deepEqual(r.value.revealFields, []);
  }
});

const createInvalid: { label: string; body: Record<string, unknown>; code: string }[] = [
  { label: 'missing target', body: {}, code: 'invalid_target' },
  { label: 'junk target', body: { target_profile_id: 'not-a-uuid' }, code: 'invalid_target' },
  { label: 'junk event', body: { target_profile_id: B, event_id: 'x' }, code: 'invalid_event_id' },
  { label: 'unknown reveal field', body: { target_profile_id: B, reveal_fields: ['ssn'] }, code: 'invalid_reveal_fields' },
  { label: 'reveal fields not array', body: { target_profile_id: B, reveal_fields: 'phone' }, code: 'invalid_reveal_fields' },
  { label: 'too many reveal fields', body: { target_profile_id: B, reveal_fields: Array(21).fill('phone') }, code: 'invalid_reveal_fields' },
];

test('validateCreateIntroInput: invalid bodies fail closed', () => {
  for (const c of createInvalid) {
    const r = validateCreateIntroInput(c.body);
    assert.equal(r.ok, false, c.label);
    if (!r.ok) assert.equal(r.code, c.code, c.label);
  }
  assert.equal(validateCreateIntroInput(null).ok, false);
});

test('validateRespondInput: accept/decline/withdraw with optional reveal fields', () => {
  const ok = validateRespondInput({ decision: 'accept', reveal_fields: ['phone'] });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.value.revealFields, ['phone']);

  const defaults = validateRespondInput({ decision: 'decline' });
  assert.equal(defaults.ok, true);
  if (defaults.ok) assert.deepEqual(defaults.value.revealFields, []);

  for (const bad of [{}, { decision: 'maybe' }, { decision: 'accept', reveal_fields: ['email'] }]) {
    const r = validateRespondInput(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

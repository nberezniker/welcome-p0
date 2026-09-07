import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSENT_PURPOSES, validateConsentInput, isConsentPurpose, isConsentScopeType } from '../../src/domain/consent';

// ---------------------------------------------------------------------------
// Purpose registry — one source of truth for consent purposes
// ---------------------------------------------------------------------------

test('consent purposes: exactly the six spec purposes', () => {
  assert.deepEqual(CONSENT_PURPOSES, [
    'public_card',
    'event_directory',
    'introduction_fields',
    'service_channel',
    'organizer_marketing',
    'product_marketing',
  ]);
});

test('consent purposes: membership helpers reject unknown values', () => {
  assert.equal(isConsentPurpose('event_directory'), true);
  assert.equal(isConsentPurpose('Event_Directory'), false);
  assert.equal(isConsentPurpose('marketing'), false);
  assert.equal(isConsentPurpose(''), false);
  assert.equal(isConsentScopeType('global'), true);
  assert.equal(isConsentScopeType('event'), true);
  assert.equal(isConsentScopeType('system'), false);
});

// ---------------------------------------------------------------------------
// validateConsentInput
// ---------------------------------------------------------------------------

const EVENT_UUID = '3f2c6e40-7e1b-4f5c-9a3d-0a1b2c3d4e5f';

test('validateConsentInput: valid global grant (default scope)', () => {
  const r = validateConsentInput({
    action: 'grant',
    purpose: 'event_directory',
    scope_type: 'global',
    policy_version: '2026-09-07',
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.scopeType, 'global');
    assert.equal(r.value.scopeId, null);
    assert.deepEqual(r.value.fieldSet, []);
  }
});

test('validateConsentInput: valid event-scoped grant with field set', () => {
  const r = validateConsentInput({
    action: 'grant',
    purpose: 'introduction_fields',
    scope_type: 'event',
    scope_id: EVENT_UUID,
    field_set: ['email', 'phone'],
    policy_version: '2026-09-07',
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.scopeId, EVENT_UUID);
    assert.deepEqual(r.value.fieldSet, ['email', 'phone']);
  }
});

test('validateConsentInput: withdraw is a valid action', () => {
  const r = validateConsentInput({ action: 'withdraw', purpose: 'organizer_marketing', scope_type: 'global', policy_version: '2026-09-07' });
  assert.equal(r.ok, true);
});

const invalidCases: { label: string; body: Record<string, unknown>; code: string }[] = [
  { label: 'missing action', body: { purpose: 'event_directory', scope_type: 'global', policy_version: 'v1' }, code: 'invalid_action' },
  { label: 'unknown action', body: { action: 'maybe', purpose: 'event_directory', scope_type: 'global', policy_version: 'v1' }, code: 'invalid_action' },
  { label: 'missing purpose', body: { action: 'grant', scope_type: 'global', policy_version: 'v1' }, code: 'invalid_purpose' },
  { label: 'unknown purpose', body: { action: 'grant', purpose: 'newsletter', scope_type: 'global', policy_version: 'v1' }, code: 'invalid_purpose' },
  { label: 'missing scope_type', body: { action: 'grant', purpose: 'event_directory', policy_version: 'v1' }, code: 'invalid_scope' },
  { label: 'unknown scope_type', body: { action: 'grant', purpose: 'event_directory', scope_type: 'tenant', policy_version: 'v1' }, code: 'invalid_scope' },
  { label: 'event scope without scope_id', body: { action: 'grant', purpose: 'event_directory', scope_type: 'event', policy_version: 'v1' }, code: 'invalid_scope_id' },
  { label: 'event scope with junk scope_id', body: { action: 'grant', purpose: 'event_directory', scope_type: 'event', scope_id: 'not-a-uuid', policy_version: 'v1' }, code: 'invalid_scope_id' },
  { label: 'global scope with scope_id', body: { action: 'grant', purpose: 'event_directory', scope_type: 'global', scope_id: EVENT_UUID, policy_version: 'v1' }, code: 'invalid_scope_id' },
  { label: 'missing policy_version', body: { action: 'grant', purpose: 'event_directory', scope_type: 'global' }, code: 'invalid_policy_version' },
  { label: 'empty policy_version', body: { action: 'grant', purpose: 'event_directory', scope_type: 'global', policy_version: '  ' }, code: 'invalid_policy_version' },
  { label: 'field_set contains a number', body: { action: 'grant', purpose: 'event_directory', scope_type: 'global', policy_version: 'v1', field_set: [1] }, code: 'invalid_field_set' },
  { label: 'field_set too long', body: { action: 'grant', purpose: 'event_directory', scope_type: 'global', policy_version: 'v1', field_set: ['x'.repeat(81)] }, code: 'invalid_field_set' },
];

test('validateConsentInput: invalid bodies fail closed with specific codes', () => {
  for (const c of invalidCases) {
    const r = validateConsentInput(c.body);
    assert.equal(r.ok, false, `expected failure for: ${c.label}`);
    if (!r.ok) assert.equal(r.code, c.code, `wrong code for: ${c.label}`);
  }
});

test('validateConsentInput: non-object bodies rejected', () => {
  assert.equal(validateConsentInput(null).ok, false);
  assert.equal(validateConsentInput('grant').ok, false);
  assert.equal(validateConsentInput([]).ok, false);
});

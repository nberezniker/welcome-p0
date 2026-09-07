import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateJoinPolicy, isValidTimezone, validateEventInput, isValidEventSlug } from '../../src/domain/events';

// ---------------------------------------------------------------------------
// isValidTimezone — IANA check via Intl
// ---------------------------------------------------------------------------

test('isValidTimezone: real IANA zones pass, junk fails', () => {
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Europe/Madrid'), true);
  assert.equal(isValidTimezone('America/New_York'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
  assert.equal(isValidTimezone(''), false);
});

// ---------------------------------------------------------------------------
// evaluateJoinPolicy — pure join decision
// ---------------------------------------------------------------------------

const baseEvent = {
  status: 'active',
  access_mode: 'public',
  join_code: null as string | null,
  max_participants: null as number | null,
  activeCount: 0,
};

test('evaluateJoinPolicy: public active event joins without code', () => {
  assert.deepEqual(evaluateJoinPolicy(baseEvent, undefined), { ok: true });
});

test('evaluateJoinPolicy: non-active event → event_not_active', () => {
  const r = evaluateJoinPolicy({ ...baseEvent, status: 'draft' }, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'event_not_active');
});

test('evaluateJoinPolicy: registration mode without/with wrong code → join_forbidden (no code leak)', () => {
  for (const provided of [undefined, null, '', 'GUESS']) {
    const r = evaluateJoinPolicy({ ...baseEvent, access_mode: 'registration', join_code: 'REAL' }, provided);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 'join_forbidden');
      assert.equal(r.message.includes('REAL'), false, 'must not leak the join code');
    }
  }
});

test('evaluateJoinPolicy: closed event joins with the exact code', () => {
  const r = evaluateJoinPolicy({ ...baseEvent, access_mode: 'closed', join_code: 'REAL' }, 'REAL');
  assert.deepEqual(r, { ok: true });
});

test('evaluateJoinPolicy: join code is ignored for public events', () => {
  assert.deepEqual(evaluateJoinPolicy({ ...baseEvent, join_code: 'SET' }, 'nope'), { ok: true });
});

test('evaluateJoinPolicy: capacity reached → event_full', () => {
  const r = evaluateJoinPolicy({ ...baseEvent, max_participants: 50, activeCount: 50 }, undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'event_full');
});

// ---------------------------------------------------------------------------
// validateEventInput
// ---------------------------------------------------------------------------

const validBody = {
  name: 'Design Meetup',
  mode: 'offline',
  access_mode: 'public',
  timezone: 'Europe/Madrid',
};

test('validateEventInput: valid minimal body', () => {
  const r = validateEventInput(validBody);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.name, 'Design Meetup');
    assert.equal(r.value.timezone, 'Europe/Madrid');
    assert.equal(r.value.startsAt, null);
    assert.equal(r.value.maxParticipants, null);
  }
});

test('validateEventInput: dates parsed, end before start rejected', () => {
  const ok = validateEventInput({
    ...validBody,
    starts_at: '2026-10-01T18:00:00Z',
    ends_at: '2026-10-01T20:00:00Z',
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.ok(ok.value.endsAt instanceof Date);

  const bad = validateEventInput({
    ...validBody,
    starts_at: '2026-10-01T18:00:00Z',
    ends_at: '2026-10-01T17:00:00Z',
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'invalid_date_range');

  const junk = validateEventInput({ ...validBody, starts_at: 'tomorrow' });
  assert.equal(junk.ok, false);
  if (!junk.ok) assert.equal(junk.code, 'invalid_starts_at');
});

const invalidInputs: { label: string; body: Record<string, unknown>; code: string }[] = [
  { label: 'missing name', body: { mode: 'offline', access_mode: 'public', timezone: 'UTC' }, code: 'invalid_name' },
  { label: 'empty name', body: { ...validBody, name: '   ' }, code: 'invalid_name' },
  { label: 'name too long', body: { ...validBody, name: 'x'.repeat(201) }, code: 'invalid_name' },
  { label: 'bad mode', body: { ...validBody, mode: 'metaverse' }, code: 'invalid_mode' },
  { label: 'missing mode', body: { name: 'X', access_mode: 'public', timezone: 'UTC' }, code: 'invalid_mode' },
  { label: 'bad access_mode', body: { ...validBody, access_mode: 'secret' }, code: 'invalid_access_mode' },
  { label: 'missing timezone', body: { name: 'X', mode: 'offline', access_mode: 'public' }, code: 'invalid_timezone' },
  { label: 'junk timezone', body: { ...validBody, timezone: 'Nowhere/Nowhere' }, code: 'invalid_timezone' },
  { label: 'max_participants zero', body: { ...validBody, max_participants: 0 }, code: 'invalid_max_participants' },
  { label: 'max_participants float', body: { ...validBody, max_participants: 10.5 }, code: 'invalid_max_participants' },
  { label: 'online_link javascript: URI', body: { ...validBody, online_link: 'javascript:alert(1)' }, code: 'invalid_online_link' },
  { label: 'location too long', body: { ...validBody, location_label: 'x'.repeat(301) }, code: 'invalid_location_label' },
];

test('validateEventInput: invalid bodies fail closed with specific codes', () => {
  for (const c of invalidInputs) {
    const r = validateEventInput(c.body);
    assert.equal(r.ok, false, `expected failure for: ${c.label}`);
    if (!r.ok) assert.equal(r.code, c.code, `wrong code for: ${c.label}`);
  }
});

test('validateEventInput: non-object bodies rejected', () => {
  assert.equal(validateEventInput(null).ok, false);
  assert.equal(validateEventInput('x').ok, false);
  assert.equal(validateEventInput([]).ok, false);
});

// ---------------------------------------------------------------------------
// isValidEventSlug — organizer-chosen slugs
// ---------------------------------------------------------------------------

test('isValidEventSlug: lowercase alnum + dashes, 3..64 chars', () => {
  assert.equal(isValidEventSlug('dev-meetup-2026'), true);
  assert.equal(isValidEventSlug('abc'), true);
  assert.equal(isValidEventSlug('ab'), false);
  assert.equal(isValidEventSlug('Has Uppercase'), false);
  assert.equal(isValidEventSlug('with_underscore'), false);
  assert.equal(isValidEventSlug('-leading-dash'), false);
  assert.equal(isValidEventSlug('x'.repeat(65)), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALENDAR_FAILURES,
  calendarControlState,
  calendarFailure,
  meetingRequest,
} from '../../src/domain/meeting-calendar';

/**
 * The introduction card's calendar control, pure half.
 *
 * The first test is the one that matters: the endpoint sends the counterpart's
 * address to Google ONLY on an explicit per-action opt-in
 * (`googleCalendarAttendees(email, optIn)`, src/domain/google-oauth.ts), and the
 * UI on this surface must not be able to opt in at all — an introduction has no
 * email to offer (its contact kinds are WhatsApp / Telegram / LinkedIn / website
 * / phone / GitHub). "Absent, not empty" is what this asserts: a field that is
 * present-but-blank is one edit away from being filled in.
 */

test('meeting request: the body carries no counterpart address, of any spelling', () => {
  const body = meetingRequest({
    counterpartSlug: 'ada-lovelace',
    startsAt: '2031-06-12T16:00:00.000Z',
    endsAt: '2031-06-12T19:00:00.000Z',
    timezone: 'Europe/Madrid',
  });

  assert.deepEqual(body, {
    counterpart_slug: 'ada-lovelace',
    starts_at: '2031-06-12T16:00:00.000Z',
    ends_at: '2031-06-12T19:00:00.000Z',
    timezone: 'Europe/Madrid',
  });
  assert.equal('include_counterpart_email' in body, false, 'the opt-in flag must not be sendable from here');
  assert.equal('counterpart_email' in body, false, 'the address field must not exist in this body');
  assert.equal(Object.keys(body).some((key) => key.includes('email')), false);
  assert.equal(JSON.stringify(body).includes('@'), false, 'no address of any kind may be built here');
});

test('meeting request: no end means no ends_at key, not an empty one', () => {
  const body = meetingRequest({
    counterpartSlug: 'ada-lovelace',
    startsAt: '2031-06-12T16:00:00.000Z',
    timezone: 'UTC',
  });
  assert.equal('ends_at' in body, false);
  // The endpoint's own rule is "absent or a valid instant" — an empty string
  // would be a 400 (invalid_end), which would look like the user's mistake.
  assert.equal(meetingRequest({ counterpartSlug: 'x', startsAt: 'i', timezone: 'UTC', endsAt: null }).ends_at, undefined);
  assert.equal(meetingRequest({ counterpartSlug: 'x', startsAt: 'i', timezone: 'UTC', endsAt: '' }).ends_at, undefined);
});

test('calendar failures: every code the route can answer with is named, and nothing is invented', () => {
  // The codes are the ones in src/app/api/me/calendar/google/route.ts.
  assert.equal(calendarFailure('not_connected'), 'not_connected');
  assert.equal(calendarFailure('reconnect_required'), 'reconnect_required');
  assert.equal(calendarFailure('scope_missing'), 'scope_missing');
  assert.equal(calendarFailure('rate_limited'), 'rate_limited');
  assert.equal(calendarFailure('google_unavailable'), 'google_unavailable');
  assert.equal(calendarFailure('counterpart_not_found'), 'counterpart_not_found');
  assert.equal(calendarFailure('invalid_timezone'), 'invalid_timezone');
  // Both time-related 400s mean the same thing to the person fixing it.
  assert.equal(calendarFailure('invalid_start'), 'invalid_time');
  assert.equal(calendarFailure('invalid_end'), 'invalid_time');
  // A code this control cannot explain — or none at all — must NOT be turned
  // into a cause: 'other' says "nothing changed", which is always true here.
  for (const unknown of ['invalid_body', 'unauthorized', 'csrf_origin', 'internal_error', undefined, null, 42, {}]) {
    assert.equal(calendarFailure(unknown), 'other', `${String(unknown)} must not be given a cause`);
  }
  // Every member has a sentence in the page's lookup, which is built from this
  // list — so the two cannot drift.
  assert.deepEqual([...CALENDAR_FAILURES], [
    'not_connected',
    'reconnect_required',
    'scope_missing',
    'rate_limited',
    'google_unavailable',
    'counterpart_not_found',
    'invalid_time',
    'invalid_timezone',
    'other',
  ]);
});

test('calendar control state: the instance fact wins over the per-user one', () => {
  // No OAuth client on this instance: nothing could ever be connected, so the
  // card must not say "not connected" as though connecting were available.
  assert.equal(calendarControlState(false, 'connected'), 'not_configured');
  assert.equal(calendarControlState(false, 'not_connected'), 'not_configured');
  assert.equal(calendarControlState(false, null), 'not_configured');

  assert.equal(calendarControlState(true, 'connected'), 'ready');
  assert.equal(calendarControlState(true, 'not_connected'), 'not_connected');
  assert.equal(calendarControlState(true, 'expired'), 'expired');
  assert.equal(calendarControlState(true, 'revoked'), 'revoked');
  // A missing grant row and an unparsable state are both "never connected",
  // never "ready": the form is only ever offered when the endpoint would accept.
  assert.equal(calendarControlState(true, null), 'not_connected');
  assert.equal(calendarControlState(true, undefined), 'not_connected');
  assert.equal(calendarControlState(true, 'nonsense'), 'not_connected');
});

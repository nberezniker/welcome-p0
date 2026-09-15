import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIcs,
  escapeIcsText,
  formatIcsUtc,
  googleCalendarUrl,
  icsFilename,
  icsUid,
} from '../../src/domain/ics';

/** ICS builder (RFC 5545): escaping, UTC, stable UID, folding, no injection. */

const NOW = new Date('2026-09-15T10:00:00Z');
const START = new Date('2026-11-05T17:30:00Z');
const END = new Date('2026-11-05T19:30:00Z');

const base = {
  id: '11111111-2222-3333-4444-555555555555',
  host: 'welcome.example',
  name: 'Founders Mixer',
  description: 'Talks and drinks',
  consentText: null as string | null,
  locationLabel: 'Carrer de Mallorca 1',
  startsAt: START,
  endsAt: END as Date | null,
  timezone: 'Europe/Madrid',
  url: 'https://welcome.example/e/mixer',
};

function lines(body: string): string[] {
  return body.split('\r\n').filter((l) => l.length > 0);
}

// --- TEXT escaping ---------------------------------------------------------

test('escape: backslash, semicolon and comma take the RFC 5545 escape', () => {
  assert.equal(escapeIcsText('a\\b;c,d'), 'a\\\\b\\;c\\,d');
});

test('escape: newlines become the literal \\n and CR never survives', () => {
  assert.equal(escapeIcsText('line1\nline2'), 'line1\\nline2');
  assert.equal(escapeIcsText('line1\r\nline2'), 'line1\\nline2');
  assert.equal(escapeIcsText('line1\rline2'), 'line1\\nline2');
  assert.equal(escapeIcsText('a\rb').includes('\r'), false);
  assert.equal(escapeIcsText('a\nb').includes('\n'), false);
});

test('escape: a CRLF property-injection attempt cannot open a new line', () => {
  const evil = 'Mixer\r\nBEGIN:VALARM\r\nTRIGGER:-PT5M\r\nEND:VALARM';
  const escaped = escapeIcsText(evil);
  assert.equal(escaped.includes('\r'), false);
  assert.equal(escaped.includes('\n'), false);
  assert.equal(escaped, 'Mixer\\nBEGIN:VALARM\\nTRIGGER:-PT5M\\nEND:VALARM');
});

test('escape: other control characters are dropped, not escaped', () => {
  assert.equal(escapeIcsText('a\u0000b\u0007c\u007fd'), 'abcd');
  // Tab is allowed by RFC 5545 and therefore kept.
  assert.equal(escapeIcsText('a\tb'), 'a\tb');
});

// --- UTC + identity --------------------------------------------------------

test('formatIcsUtc: always UTC, second precision, trailing Z', () => {
  assert.equal(formatIcsUtc(new Date('2026-01-02T03:04:05Z')), '20260102T030405Z');
  assert.equal(formatIcsUtc(new Date('2026-12-31T23:59:59.999Z')), '20261231T235959Z');
});

test('icsUid: stable per event id, host sanitized, never derived from the name', () => {
  const uid = icsUid('event-1', 'welcome.example');
  assert.equal(uid, 'welcome-event-event-1@welcome.example');
  assert.equal(icsUid('event-1', 'welcome.example'), uid);
  assert.equal(icsUid('event-2', 'welcome.example') === uid, false);
  assert.equal(icsUid('event-1', 'evil host/with spaces'), 'welcome-event-event-1@evilhostwithspaces');
  assert.equal(icsUid('event-1', ''), 'welcome-event-event-1@welcome');
});

test('icsFilename: url-safe, always .ics', () => {
  assert.equal(icsFilename('e2e-mixer'), 'welcome-e2e-mixer.ics');
  assert.equal(icsFilename('../../etc/passwd'), 'welcome-etc-passwd.ics');
});

// --- the calendar file -----------------------------------------------------

test('buildIcs: UTC stamps, timezone as metadata, CRLF line endings only', () => {
  const body = buildIcs(base, { now: NOW });
  const l = lines(body);

  assert.equal(l[0], 'BEGIN:VCALENDAR');
  assert.ok(l.includes('VERSION:2.0'));
  assert.ok(l.includes('X-WR-TIMEZONE:Europe/Madrid'));
  assert.ok(l.includes('DTSTAMP:20260915T100000Z'));
  assert.ok(l.includes('DTSTART:20261105T173000Z'));
  assert.ok(l.includes('DTEND:20261105T193000Z'));
  assert.equal(l[l.length - 1], 'END:VCALENDAR');
  assert.ok(body.endsWith('\r\n'));
  // No bare LF anywhere: every newline is a CRLF pair.
  assert.equal(body.replace(/\r\n/g, '').includes('\n'), false);
});

test('buildIcs: no end time → DTEND is omitted rather than invented', () => {
  const body = buildIcs({ ...base, endsAt: null }, { now: NOW });
  assert.equal(body.includes('DTEND'), false);
  assert.ok(body.includes('DTSTART:20261105T173000Z'));
});

test('buildIcs: UID is stable across downloads and independent of DTSTAMP', () => {
  const first = buildIcs(base, { now: NOW });
  const second = buildIcs(base, { now: new Date('2027-01-01T00:00:00Z') });
  const uid = (body: string) => lines(body).find((l) => l.startsWith('UID:'))!;
  assert.equal(uid(first), `UID:${icsUid(base.id, base.host)}`);
  assert.equal(uid(first), uid(second));
  assert.notEqual(lines(first).find((l) => l.startsWith('DTSTAMP:')), lines(second).find((l) => l.startsWith('DTSTAMP:')));
});

test('buildIcs: injection through name/location/description is neutralized', () => {
  const body = buildIcs(
    {
      ...base,
      name: 'Mixer\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Injected',
      locationLabel: 'Room;1,Floor 2',
      description: 'a\\b',
    },
    { now: NOW },
  );
  const l = lines(body);
  // Exactly one VEVENT: the injected one never became a property.
  assert.equal(l.filter((line) => line === 'BEGIN:VEVENT').length, 1);
  assert.equal(l.filter((line) => line === 'END:VEVENT').length, 1);
  assert.ok(l.includes('LOCATION:Room\\;1\\,Floor 2'));
  assert.ok(l.includes('DESCRIPTION:a\\\\b'));
});

test('buildIcs: consent text is appended to DESCRIPTION, empty parts dropped', () => {
  const withConsent = buildIcs({ ...base, consentText: 'Recording is opt-in.' }, { now: NOW });
  assert.ok(lines(withConsent).includes('DESCRIPTION:Talks and drinks\\n\\nRecording is opt-in.'));

  const noDescription = buildIcs({ ...base, description: null, consentText: 'Only consent' }, { now: NOW });
  assert.ok(lines(noDescription).includes('DESCRIPTION:Only consent'));

  const neither = buildIcs({ ...base, description: null, consentText: null }, { now: NOW });
  assert.equal(neither.includes('DESCRIPTION'), false);
});

test('buildIcs: no location and no url → those properties are simply absent', () => {
  const body = buildIcs({ ...base, locationLabel: null, url: null }, { now: NOW });
  assert.equal(body.includes('LOCATION:'), false);
  assert.equal(body.includes('\nURL:'), false);
});

test('buildIcs: the builder is a whitelist — an unexpected private field never leaks', () => {
  // `online_link` is membership-conditional (src/lib/event-view.ts) and must
  // never ride in a downloaded file; the input type does not have it, and a
  // caller that passes one anyway gets it ignored.
  const sentinel = 'https://meet.example/secret-room-token';
  const body = buildIcs({ ...base, online_link: sentinel } as unknown as Parameters<typeof buildIcs>[0], { now: NOW });
  assert.equal(body.includes(sentinel), false);
  assert.equal(body.includes('secret-room-token'), false);
});

test('buildIcs: long values are folded to <=75 octets and unfold back to the same text', () => {
  const longName = `${'Ünicode Näme '.repeat(20)}end`;
  const body = buildIcs({ ...base, name: longName }, { now: NOW });

  for (const line of body.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line too long: ${Buffer.byteLength(line, 'utf8')}`);
  }
  // RFC 5545 unfolding: remove CRLF + single space and the original text is back.
  const unfolded = body.replace(/\r\n /g, '');
  assert.ok(unfolded.includes(`SUMMARY:${escapeIcsText(longName)}`));
});

// --- Google template link --------------------------------------------------

test('googleCalendarUrl: TEMPLATE action, UTC range, encoded details and location', () => {
  const url = new URL(googleCalendarUrl({ name: 'Mixer', description: 'Talks & drinks', locationLabel: 'Madrid', startsAt: START, endsAt: END }));
  assert.equal(url.origin + url.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(url.searchParams.get('action'), 'TEMPLATE');
  assert.equal(url.searchParams.get('text'), 'Mixer');
  assert.equal(url.searchParams.get('dates'), '20261105T173000Z/20261105T193000Z');
  assert.equal(url.searchParams.get('details'), 'Talks & drinks');
  assert.equal(url.searchParams.get('location'), 'Madrid');
});

test('googleCalendarUrl: no end → zero-length range; empty details omitted', () => {
  const url = new URL(googleCalendarUrl({ name: 'Mixer', description: '  ', locationLabel: null, startsAt: START, endsAt: null }));
  assert.equal(url.searchParams.get('dates'), '20261105T173000Z/20261105T173000Z');
  assert.equal(url.searchParams.has('details'), false);
  assert.equal(url.searchParams.has('location'), false);
});

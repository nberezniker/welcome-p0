import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEventWhen } from '../../src/lib/event-time';
import type { Locale } from '../../src/i18n/locale';

/**
 * Event schedule formatting (Issue: the date printed twice). One event page and
 * one preview image read the same string, so what is pinned here is the
 * *decision* — compact when the two instants are one calendar day in the EVENT's
 * timezone, full when they are not — plus the fallbacks nobody should lose.
 *
 * The assertions derive their expectations from Intl for the same locale and
 * timezone rather than hardcoding an English string, so a locale change moves
 * the test with the product instead of breaking it.
 */

/** Mirrors src/lib/event-time.ts; spelled out again so the test pins the
 * product's date style (en-GB: "1 May 2031", never "May 1, 2031"). */
const DATE_TAGS: Record<Locale, string> = { en: 'en-GB', ru: 'ru-RU', es: 'es-ES' };

function dateOnly(date: Date, timezone: string, locale: Locale): string {
  return shape(
    new Intl.DateTimeFormat(DATE_TAGS[locale], { timeZone: timezone, dateStyle: 'medium' }).format(date),
  );
}

/**
 * ICU separates the date from the time with a narrow no-break space in some
 * locales (ru: "2031 г., 18:00" — U+202F, while a date-only format uses a plain
 * space). Flattened here so the assertions can talk about the date as text
 * without pinning an invisible character.
 */
function shape(value: string | null): string {
  return (value ?? '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ');
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const LOCALES: readonly Locale[] = ['en', 'ru', 'es'];

test('schedule: one day in the event timezone prints its date exactly once', () => {
  // 18:00–21:00 Madrid on 2 June.
  const start = new Date('2031-06-02T16:00:00Z');
  const end = new Date('2031-06-02T19:00:00Z');
  for (const locale of LOCALES) {
    const out = shape(formatEventWhen(start, end, 'Europe/Madrid', locale));
    assert.ok(out.length > 0, `${locale}: a dated event must render`);
    assert.equal(
      countOf(out, dateOnly(start, 'Europe/Madrid', locale)),
      1,
      `${locale}: the date must appear once — got ${out}`,
    );
    // The compact form joins the two times; it does not use the "start — end"
    // frame the multi-day form needs.
    assert.doesNotMatch(out, / — /, `${locale}: the compact form has no em-dash separator`);
    assert.match(out, /–/, `${locale}: the times are a range — got ${out}`);
  }

  // The English shape, written out once so the test states the product decision
  // rather than only its structure.
  assert.equal(shape(formatEventWhen(start, end, 'Europe/Madrid', 'en')), '2 Jun 2031, 18:00–21:00');
  assert.equal(shape(formatEventWhen(start, end, 'Europe/Madrid', 'ru')), '2 июн. 2031 г., 18:00–21:00');
});

test('schedule: the compact decision is made in the EVENT timezone, not in UTC', () => {
  // 18:00–20:00 in Los Angeles on 2 June = 01:00–03:00Z on 3 June. UTC and the
  // event disagree about which day this is, and the page must show the day the
  // organizer meant: the 2nd.
  const start = new Date('2031-06-03T01:00:00Z');
  const end = new Date('2031-06-03T03:00:00Z');
  const utcDay = start.toISOString().slice(0, 10);
  const eventDay = dateOnly(start, 'America/Los_Angeles', 'en');
  assert.equal(utcDay, '2031-06-03');
  assert.notEqual(eventDay, '3 Jun 2031', 'the fixture must sit on different days in the two zones');

  const out = shape(formatEventWhen(start, end, 'America/Los_Angeles', 'en'));
  assert.equal(out, '2 Jun 2031, 18:00–20:00');
  assert.match(out, new RegExp(`^${eventDay}`), 'the rendered date is the event-local one');
  assert.doesNotMatch(out, /3 Jun/, 'the UTC day must never leak into the event schedule');
});

test('schedule: a window straddling UTC midnight is still one day in the event timezone', () => {
  // 09:00–11:00 in Sydney on 2 June = 23:00Z on 1 June → 01:00Z on 2 June. The
  // two UTC stamps fall on DIFFERENT days; the local window does not. Comparing
  // UTC calendar dates would print the date twice here — the bug this fixes.
  const start = new Date('2031-06-01T23:00:00Z');
  const end = new Date('2031-06-02T01:00:00Z');
  assert.notEqual(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));

  for (const locale of LOCALES) {
    const out = shape(formatEventWhen(start, end, 'Australia/Sydney', locale));
    assert.ok(out.length > 0, `${locale}: a dated event must render`);
    assert.equal(
      countOf(out, dateOnly(start, 'Australia/Sydney', locale)),
      1,
      `${locale}: one local day, one date — got ${out}`,
    );
  }
  assert.equal(shape(formatEventWhen(start, end, 'Australia/Sydney', 'en')), '2 Jun 2031, 09:00–11:00');
  // The same instants rendered in UTC really are two days — proof the fixture is
  // a genuine timezone boundary and not a same-day case in disguise.
  assert.equal(
    shape(formatEventWhen(start, end, 'UTC', 'en')),
    '1 Jun 2031, 23:00 — 2 Jun 2031, 01:00',
  );
});

test('schedule: an event spanning two days keeps the full start — end form', () => {
  const start = new Date('2031-06-02T20:00:00Z'); // 22:00 Madrid, 2 June
  const end = new Date('2031-06-03T16:00:00Z'); // 18:00 Madrid, 3 June
  for (const locale of LOCALES) {
    const out = shape(formatEventWhen(start, end, 'Europe/Madrid', locale));
    assert.ok(out.length > 0, `${locale}: a dated event must render`);
    assert.equal(
      countOf(out, dateOnly(start, 'Europe/Madrid', locale)),
      1,
      `${locale}: the start date appears — got ${out}`,
    );
    assert.equal(
      countOf(out, dateOnly(end, 'Europe/Madrid', locale)),
      1,
      `${locale}: the end date appears — got ${out}`,
    );
    assert.match(out, / — /, `${locale}: the multi-day form keeps its separator`);
  }
  assert.equal(
    shape(formatEventWhen(start, end, 'Europe/Madrid', 'en')),
    '2 Jun 2031, 22:00 — 3 Jun 2031, 18:00',
  );
});

test('schedule: an event without an end keeps the single start stamp', () => {
  const start = new Date('2031-06-02T16:00:00Z');
  assert.equal(shape(formatEventWhen(start, null, 'Europe/Madrid', 'en')), '2 Jun 2031, 18:00');
  assert.equal(shape(formatEventWhen(start, null, 'Europe/Madrid', 'es')), '2 jun 2031, 18:00');
});

test('schedule: an event without a start renders nothing at all', () => {
  // A date-less events row is legal; the page hides the line instead of
  // inventing a time.
  assert.equal(formatEventWhen(null, null, 'Europe/Madrid', 'en'), null);
  assert.equal(formatEventWhen(null, new Date('2031-06-02T16:00:00Z'), 'Europe/Madrid', 'en'), null);
});

test('schedule: an unusable timezone degrades to the raw stamps and never throws', () => {
  const start = new Date('2031-06-02T16:00:00Z');
  const end = new Date('2031-06-02T19:00:00Z');
  for (const timezone of ['Mars/Olympus', '', 'Europe/Madrid; DROP TABLE events']) {
    assert.doesNotThrow(() => formatEventWhen(start, end, timezone, 'en'), timezone);
    assert.equal(
      formatEventWhen(start, end, timezone, 'en'),
      `${start.toISOString()} — ${end.toISOString()}`,
      timezone,
    );
    assert.equal(formatEventWhen(start, null, timezone, 'en'), start.toISOString(), timezone);
  }
});

test('schedule: an end before the start is not turned into a range', () => {
  // Bad data still has to render; it just must not be silently rewritten into a
  // backwards range.
  assert.equal(
    shape(
      formatEventWhen(
        new Date('2031-06-03T16:00:00Z'),
        new Date('2031-06-02T16:00:00Z'),
        'Europe/Madrid',
        'en',
      ),
    ),
    '3 Jun 2031, 18:00 — 2 Jun 2031, 18:00',
  );
});

import type { Locale } from '../i18n/locale';

/**
 * Event time formatting, shared by the public event page (/e/[slug]) and its
 * preview image (/e/[slug]/opengraph-image). Both show the same schedule and the
 * image shows it as a single line, so the string is composed once, here.
 */

/** UI locale → the locale used for the date itself (en-GB, not en-US: the
 * product writes "1 May 2031", not "May 1, 2031"). */
const DATE_LOCALES: Record<Locale, string> = { en: 'en-GB', ru: 'ru-RU', es: 'es-ES' };

/** The one clock shape both the page and the image read an event through. */
function formatterFor(timezone: string, locale: Locale): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(DATE_LOCALES[locale], {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Formats an instant in the event's own timezone: an attendee reading the page
 * from another country must see the wall-clock time the organizer meant.
 * An unusable timezone (bad DB value) falls back to the raw UTC stamp instead
 * of throwing — the page should still render.
 */
function formatInTz(date: Date, timezone: string, locale: Locale): string {
  try {
    return formatterFor(timezone, locale).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * The day an instant falls on IN the event's timezone, as a value two instants
 * can be compared by. Read off the formatted wall clock rather than off the UTC
 * stamps, because those are not the same day: a Los Angeles meetup running
 * 18:00–20:00 on 2 June is stamped 01:00–03:00Z on 3 June.
 */
function dayKey(date: Date, formatter: Intl.DateTimeFormat): string {
  return formatter
    .formatToParts(date)
    .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
    .map((part) => part.value)
    .join('-');
}

/**
 * The compact "12 Sept 2026, 18:00–21:00" a one-day event deserves, or null when
 * the two instants are not one calendar day in the event's timezone (or the
 * timezone cannot be used) — the caller then keeps the full form.
 *
 * `Intl.formatRange` is what actually drops the repeated date and picks the
 * locale's own separator, so the same-day decision and the rendering cannot
 * disagree about what "same day" means.
 */
function formatSameDayRange(
  start: Date,
  end: Date,
  timezone: string,
  locale: Locale,
): string | null {
  try {
    const formatter = formatterFor(timezone, locale);
    if (dayKey(start, formatter) !== dayKey(end, formatter)) return null;
    return formatter.formatRange(start, end);
  } catch {
    return null;
  }
}

/**
 * One-line schedule, or null when the event has no start (an events row without
 * a date is legal — the calendar affordances are simply absent for it).
 *
 * A same-day event prints its date once ("12 Sept 2026, 18:00–21:00"); an event
 * spanning two days keeps the full "start — end" form, where the second date
 * carries information. The compact form matters most in the preview image: it is
 * a single line, and a repeated date is the first thing elided there.
 */
export function formatEventWhen(
  startsAt: Date | null,
  endsAt: Date | null,
  timezone: string,
  locale: Locale,
): string | null {
  if (!startsAt) return null;
  const start = formatInTz(startsAt, timezone, locale);
  if (!endsAt) return start;
  const sameDay = formatSameDayRange(startsAt, endsAt, timezone, locale);
  if (sameDay) return sameDay;
  return `${start} — ${formatInTz(endsAt, timezone, locale)}`;
}

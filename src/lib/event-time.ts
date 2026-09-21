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
  return tryFormatInTz(date, timezone, locale) ?? date.toISOString();
}

/**
 * The same formatting, or null when the timezone cannot be used at all (a bad DB
 * value). This is the single probe for "the zone is usable": the UTC fallback
 * above and the zone name `formatEventSchedule` prints both read it, so a line
 * that carries a zone's name can never be a UTC stamp wearing that name.
 */
function tryFormatInTz(date: Date, timezone: string, locale: Locale): string | null {
  try {
    return formatterFor(timezone, locale).format(date);
  } catch {
    return null;
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

/**
 * The schedule line the EVENT PAGE shows: the string above with the organizer's
 * zone named once, after it —
 *
 *   "12 Jun 2031, 18:00–21:00 · Europe/Madrid"
 *
 * It exists because the page printed the zone twice: once inside the
 * "When (event timezone)" label and again in a "Timezone (IANA)" row of its own.
 * The zone belongs to the schedule it describes, so it travels on that line.
 *
 * THE HONEST FALLBACK IS WHY THIS LIVES HERE. When the zone cannot be used,
 * `formatEventWhen` prints the raw UTC stamp rather than a silently wrong wall
 * clock; appending the unusable zone's name to that stamp would undo the
 * honesty in the one place it matters most. So the name is appended only when
 * the SAME probe that formatted the clock (`tryFormatInTz`) could use the zone —
 * otherwise the line is the fallback alone, unlabelled. Nothing is guessed or
 * "fixed up": a bad zone renders as a bad zone, which is what makes it fixable.
 *
 * Null exactly when `formatEventWhen` is: no start, no line. The caller owns what
 * to show instead (the event page keeps the zone on a row of its own there —
 * there is no clock for it to qualify).
 *
 * The preview image keeps calling `formatEventWhen`: it is a single line of
 * pixels, where the zone costs more room than it explains.
 */
export function formatEventSchedule(
  startsAt: Date | null,
  endsAt: Date | null,
  timezone: string,
  locale: Locale,
): string | null {
  const when = formatEventWhen(startsAt, endsAt, timezone, locale);
  if (when === null || !startsAt) return null;
  return tryFormatInTz(startsAt, timezone, locale) === null ? when : `${when} · ${timezone}`;
}

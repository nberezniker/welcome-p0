import type { Locale } from '../i18n/locale';

/**
 * Event time formatting, shared by the public event page (/e/[slug]) and its
 * preview image (/e/[slug]/opengraph-image). Both show the same schedule and the
 * image shows it as a single line, so the string is composed once, here.
 */

/** UI locale → the locale used for the date itself (en-GB, not en-US: the
 * product writes "1 May 2031", not "May 1, 2031"). */
const DATE_LOCALES: Record<Locale, string> = { en: 'en-GB', ru: 'ru-RU', es: 'es-ES' };

/**
 * Formats an instant in the event's own timezone: an attendee reading the page
 * from another country must see the wall-clock time the organizer meant.
 * An unusable timezone (bad DB value) falls back to the raw UTC stamp instead
 * of throwing — the page should still render.
 */
function formatInTz(date: Date, timezone: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(DATE_LOCALES[locale], {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * One-line schedule, or null when the event has no start (an events row without
 * a date is legal — the calendar affordances are simply absent for it).
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
  return `${start} — ${formatInTz(endsAt, timezone, locale)}`;
}

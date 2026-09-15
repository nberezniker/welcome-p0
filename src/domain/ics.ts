/**
 * ICS (RFC 5545) builder for an event — the "add to calendar" half of the
 * interop layer (`docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md` §A3
 * row "ICS (календарь)" + Phase-1 item 2).
 *
 * Three rules shape this module:
 *
 *   1. **Nothing private, ever.** The builder takes a whitelist of public event
 *      fields. `online_link` is NOT one of them: the room link is
 *      membership-conditional (src/lib/event-view.ts) and a downloaded .ics
 *      outlives every access check, so it must never travel inside one.
 *   2. **UTC only, timezone as metadata.** DTSTART/DTEND are emitted in UTC
 *      (`…Z`). The organizer's zone still travels as `X-WR-TIMEZONE`, so a
 *      client that honours it shows the intended local time while a client that
 *      ignores it stays correct rather than off by an offset.
 *   3. **No injection.** Every user-controlled value goes through `escapeText`,
 *      which normalizes CR/LF and escapes them as `\n` — a value containing
 *      "…\r\nBEGIN:VALARM" can never open a component (RFC 5545 §3.3.11).
 *
 * Pure and dependency-free: the route handler (src/app/api/events/…/ics) owns
 * DB access and headers, this module owns the bytes.
 */

/** Max octets of a content line, excluding CRLF (RFC 5545 §3.1). */
const FOLD_LIMIT = 75;

export interface IcsEventInput {
  /** Stable database id — the UID is derived from it, never from the name. */
  id: string;
  /** Host used to make the UID globally unique (e.g. `welcome.example`). */
  host: string;
  name: string;
  description: string | null;
  /** Consent line shown on the event page; appended to DESCRIPTION. */
  consentText: string | null;
  locationLabel: string | null;
  startsAt: Date;
  endsAt: Date | null;
  /** IANA zone of the organizer's schedule — metadata only (see header). */
  timezone: string;
  /** Public event page, when the caller has a base URL. */
  url?: string | null;
}

export interface IcsOptions {
  /** Injectable clock: DTSTAMP is the only non-deterministic field. */
  now?: Date;
}

/** UTF-8 length of one code point (no Buffer/TextEncoder: isomorphic). */
function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** RFC 5545 §3.1 folding: ≤75 octets, continuations start with one space. */
function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = FOLD_LIMIT;
  for (const char of line) {
    const size = codePointBytes(char.codePointAt(0) ?? 0);
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
      // A continuation line spends one octet on its leading space.
      limit = FOLD_LIMIT - 1;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

/**
 * RFC 5545 §3.3.11 TEXT escaping, in the only order that is safe:
 * CR/LF first (so no raw line break survives), then backslash, then the two
 * structural separators, and finally newlines as the literal `\n` escape.
 * Control characters that calendar clients do not expect are dropped.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\r\n|\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** `YYYYMMDDTHHMMSSZ` — always UTC, never a floating local time. */
export function formatIcsUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** A UID is `<stable id>@<host>`: same event → same UID on every download. */
export function icsUid(id: string, host: string): string {
  const safeHost = host.replace(/[^A-Za-z0-9.:-]/g, '') || 'welcome';
  return `welcome-event-${id}@${safeHost}`;
}

/**
 * Filename-safe event slug for `Content-Disposition`. Keeps a download from
 * being named after whatever the organizer typed.
 */
export function icsFilename(slug: string): string {
  const safe = slug.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `welcome-${safe || 'event'}.ics`;
}

/**
 * Builds the complete VCALENDAR. `DTEND` is omitted when the organizer set no
 * end — an invented duration would be a lie in someone's calendar.
 */
export function buildIcs(input: IcsEventInput, options: IcsOptions = {}): string {
  const now = options.now ?? new Date();
  const description = [input.description, input.consentText]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join('\n\n');

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WELCOME//Event//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-TIMEZONE:${escapeIcsText(input.timezone)}`,
    'BEGIN:VEVENT',
    `UID:${icsUid(input.id, input.host)}`,
    `DTSTAMP:${formatIcsUtc(now)}`,
    `DTSTART:${formatIcsUtc(input.startsAt)}`,
  ];

  if (input.endsAt) lines.push(`DTEND:${formatIcsUtc(input.endsAt)}`);
  lines.push(`SUMMARY:${escapeIcsText(input.name)}`);
  if (description.length > 0) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  if (input.locationLabel) lines.push(`LOCATION:${escapeIcsText(input.locationLabel)}`);
  if (input.url) lines.push(`URL:${escapeIcsText(input.url)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/**
 * "Add to Google Calendar" template URL — the link form of the same data, for
 * visitors who will not download a file. `dates` is UTC (`…Z/…Z`); with no end
 * the event is zero-length, which Google renders as a point in time.
 */
export function googleCalendarUrl(input: {
  name: string;
  description: string | null;
  locationLabel: string | null;
  startsAt: Date;
  endsAt: Date | null;
}): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: input.name,
    dates: `${formatIcsUtc(input.startsAt)}/${formatIcsUtc(input.endsAt ?? input.startsAt)}`,
  });
  const details = (input.description ?? '').trim();
  if (details.length > 0) params.set('details', details);
  if (input.locationLabel) params.set('location', input.locationLabel);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

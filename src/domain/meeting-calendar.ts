/**
 * The "put the agreed meeting in my own calendar" request, and the vocabulary for
 * reading its answers — the pure half of the introduction card's calendar control
 * (src/app/me/introductions/intro-calendar.tsx).
 *
 * Endpoint: POST /api/me/calendar/google (src/app/api/me/calendar/google/route.ts),
 * the Phase-2 half of the interop layer
 * (docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md §D item 6).
 *
 * TWO THINGS THIS MODULE EXISTS TO MAKE STRUCTURAL RATHER THAN PROMISED:
 *
 *   1. **THE BODY HAS NO EMAIL FIELD.** `include_counterpart_email` and
 *      `counterpart_email` are not "empty" here — they are ABSENT, so this path
 *      cannot send the counterpart's address to Google even by accident. That
 *      matches the endpoint's own default (`googleCalendarAttendees(email, optIn)`
 *      returns `[]` unless the caller opts in for that one action,
 *      src/domain/google-oauth.ts), and it costs nothing to guarantee: an
 *      introduction has no address to offer anyway, because the contact kinds it
 *      can reveal are WhatsApp / Telegram / LinkedIn / website / phone / GitHub
 *      and never an email. Send the address from an explicit opt-in surface if
 *      that is ever wanted; do not add a field here.
 *   2. **THE INSTANT AND THE ZONE COME FROM ONE PLACE.** `startsAt` is the
 *      device's own reading of the wall clock the user typed, and `timezone` is
 *      that same device zone. Interpreting a wall clock in a zone OTHER than the
 *      one that parsed it is how a meeting lands an hour off, silently, so this
 *      interface does not offer it: the caller reads the device zone once and
 *      passes it here unchanged.
 *
 * Pure and dependency-free: no `fetch`, no clock, no dictionary, no DB. The
 * caller owns the request and the wording; this module owns the shape.
 */

export interface MeetingInput {
  /** The counterpart's PUBLIC CARD slug — what the endpoint resolves (profiles.public_slug). */
  counterpartSlug: string;
  /** Absolute instant, ISO 8601. */
  startsAt: string;
  /** Optional: omitted entirely when there is no end. */
  endsAt?: string | null;
  /** IANA zone the instant belongs to — the user's own device zone. */
  timezone: string;
}

/**
 * The exact JSON body this UI sends. Deliberately a `Record<string, string>` of
 * KNOWN keys rather than a passthrough of form state: a caller cannot smuggle an
 * unexpected field into the request by adding it to the object it holds.
 */
export function meetingRequest(input: MeetingInput): Record<string, string> {
  const body: Record<string, string> = {
    counterpart_slug: input.counterpartSlug,
    starts_at: input.startsAt,
    timezone: input.timezone,
  };
  if (input.endsAt) body.ends_at = input.endsAt;
  return body;
}

/**
 * What a failure MEANS to this control — the endpoint's codes
 * (src/app/api/me/calendar/google/route.ts) folded into the causes a user can
 * act on. Every code the route can answer with is named here; anything
 * unrecognised becomes `other`, which the UI reports as "nothing was changed"
 * rather than inventing a cause it cannot know.
 *
 * `invalid_start` and `invalid_end` share one member: from the user's side both
 * mean "check the times", which is also the only fix available.
 */
export type CalendarFailure =
  | 'not_connected'
  | 'reconnect_required'
  | 'scope_missing'
  | 'rate_limited'
  | 'google_unavailable'
  | 'counterpart_not_found'
  | 'invalid_time'
  | 'invalid_timezone'
  | 'other';

/**
 * Every member, once. The page builds one dictionary entry per member from this
 * list, so a failure cannot be added to the union without a sentence being asked
 * for in all three languages (tests/unit/i18n-dictionaries.test.ts keeps the
 * dictionaries in parity).
 */
export const CALENDAR_FAILURES: readonly CalendarFailure[] = [
  'not_connected',
  'reconnect_required',
  'scope_missing',
  'rate_limited',
  'google_unavailable',
  'counterpart_not_found',
  'invalid_time',
  'invalid_timezone',
  'other',
];

export function calendarFailure(code: unknown): CalendarFailure {
  switch (code) {
    case 'not_connected':
      return 'not_connected';
    case 'reconnect_required':
      return 'reconnect_required';
    case 'scope_missing':
      return 'scope_missing';
    case 'rate_limited':
      return 'rate_limited';
    case 'google_unavailable':
      return 'google_unavailable';
    case 'counterpart_not_found':
      return 'counterpart_not_found';
    case 'invalid_start':
    case 'invalid_end':
      return 'invalid_time';
    case 'invalid_timezone':
      return 'invalid_timezone';
    default:
      return 'other';
  }
}

/** The states the control can be in before the user acts. */
export type CalendarControlState = 'not_configured' | 'not_connected' | 'expired' | 'revoked' | 'ready';

/**
 * Which of those the card actually is, from its two independent inputs: whether
 * THIS INSTANCE has an OAuth client at all (the provider registry, env-derived)
 * and what this USER's grant is (our own database). The instance fact wins, for
 * the reason /me/connections gives: there is no point saying "not connected"
 * when nothing could ever be connected here.
 *
 * `ready` is the only state in which the card renders the form — the other four
 * say why they cannot, in the user's language, instead of offering a control
 * whose press could only fail.
 */
export function calendarControlState(
  configured: boolean,
  grant: string | null | undefined,
): CalendarControlState {
  if (!configured) return 'not_configured';
  if (grant === 'connected') return 'ready';
  if (grant === 'expired') return 'expired';
  if (grant === 'revoked') return 'revoked';
  return 'not_connected';
}

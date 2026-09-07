import { randomBytes } from 'node:crypto';
import type { Validated } from './profile';

/** Events domain: pure input validation + join policy.
 * DB access stays in routes / src/lib — this module is unit-testable. */

export const EVENT_MODES = ['offline', 'online', 'hybrid'] as const;
export type EventMode = (typeof EVENT_MODES)[number];

export const EVENT_ACCESS_MODES = ['public', 'closed', 'registration'] as const;
export type EventAccessMode = (typeof EVENT_ACCESS_MODES)[number];

export interface EventInput {
  name: string;
  mode: EventMode;
  accessMode: EventAccessMode;
  timezone: string;
  startsAt: Date | null;
  endsAt: Date | null;
  maxParticipants: number | null;
  locationLabel: string | null;
  onlineLink: string | null;
  description: string | null;
  consentText: string | null;
}

const NAME_MAX = 200;
const LOCATION_MAX = 300;
const LINK_MAX = 500;
const DESCRIPTION_MAX = 2000;
const CONSENT_TEXT_MAX = 5000;
const MAX_PARTICIPANTS_CAP = 100_000;

/** IANA timezone validation via Intl (throws RangeError for unknown zones). */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Event slugs are lowercase alnum + dashes, 3..64 chars, no edge dashes. */
const EVENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
export function isValidEventSlug(value: string): boolean {
  return EVENT_SLUG_RE.test(value);
}

/** Random opaque event slug (128-bit, base64url). Safe in URLs and QR payloads. */
export function generateEventSlug(): string {
  return randomBytes(16).toString('base64url');
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Rejects values that V8's Date parser would misread (e.g. '1' → 2001-01-01). */
function isIsoLikeDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())) return false;
  return !Number.isNaN(Date.parse(value));
}

function optString(body: Record<string, unknown>, key: string, maxLength: number): string | null | undefined {
  if (!(key in body) || body[key] === null || body[key] === undefined) return null;
  const v = body[key];
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) return undefined;
  return trimmed;
}

function optDateTime(body: Record<string, unknown>, key: string): Date | null | undefined {
  if (!(key in body) || body[key] === null || body[key] === undefined) return null;
  const v = body[key];
  if (typeof v !== 'string') return undefined;
  if (!isIsoLikeDateTime(v.trim())) return undefined;
  return new Date(v);
}

/** Validates a POST /api/organizer/events body. */
export function validateEventInput(body: unknown): Validated<EventInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;

  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 1 || name.length > NAME_MAX) {
    return { ok: false, code: 'invalid_name', message: `name is required (1..${NAME_MAX} chars)` };
  }

  if (typeof b.mode !== 'string' || !(EVENT_MODES as readonly string[]).includes(b.mode)) {
    return { ok: false, code: 'invalid_mode', message: `mode must be one of: ${EVENT_MODES.join(', ')}` };
  }

  if (typeof b.access_mode !== 'string' || !(EVENT_ACCESS_MODES as readonly string[]).includes(b.access_mode)) {
    return { ok: false, code: 'invalid_access_mode', message: `access_mode must be one of: ${EVENT_ACCESS_MODES.join(', ')}` };
  }

  const timezone = typeof b.timezone === 'string' ? b.timezone.trim() : '';
  if (!isValidTimezone(timezone)) {
    return { ok: false, code: 'invalid_timezone', message: 'timezone must be a valid IANA zone (e.g. Europe/Madrid)' };
  }

  const startsAt = optDateTime(b, 'starts_at');
  if (startsAt === undefined) return { ok: false, code: 'invalid_starts_at', message: 'starts_at must be an ISO 8601 timestamp' };
  const endsAt = optDateTime(b, 'ends_at');
  if (endsAt === undefined) return { ok: false, code: 'invalid_ends_at', message: 'ends_at must be an ISO 8601 timestamp' };
  if (startsAt && endsAt && endsAt.getTime() < startsAt.getTime()) {
    return { ok: false, code: 'invalid_date_range', message: 'ends_at must not be before starts_at' };
  }

  let maxParticipants: number | null = null;
  if (b.max_participants !== undefined && b.max_participants !== null) {
    const mp = b.max_participants;
    if (typeof mp !== 'number' || !Number.isInteger(mp) || mp < 1 || mp > MAX_PARTICIPANTS_CAP) {
      return { ok: false, code: 'invalid_max_participants', message: `max_participants must be an integer 1..${MAX_PARTICIPANTS_CAP}` };
    }
    maxParticipants = mp;
  }

  const locationLabel = optString(b, 'location_label', LOCATION_MAX);
  if (locationLabel === undefined) return { ok: false, code: 'invalid_location_label', message: `location_label must be a string up to ${LOCATION_MAX} chars` };
  const onlineLink = optString(b, 'online_link', LINK_MAX);
  if (onlineLink === undefined) return { ok: false, code: 'invalid_online_link', message: `online_link must be a string up to ${LINK_MAX} chars` };
  if (onlineLink && !isHttpUrl(onlineLink)) {
    return { ok: false, code: 'invalid_online_link', message: 'online_link must be an http(s) URL' };
  }
  const description = optString(b, 'description', DESCRIPTION_MAX);
  if (description === undefined) return { ok: false, code: 'invalid_description', message: `description must be a string up to ${DESCRIPTION_MAX} chars` };
  const consentText = optString(b, 'consent_text', CONSENT_TEXT_MAX);
  if (consentText === undefined) return { ok: false, code: 'invalid_consent_text', message: `consent_text must be a string up to ${CONSENT_TEXT_MAX} chars` };

  return {
    ok: true,
    value: {
      name,
      mode: b.mode as EventMode,
      accessMode: b.access_mode as EventAccessMode,
      timezone,
      startsAt,
      endsAt,
      maxParticipants,
      locationLabel,
      onlineLink,
      description,
      consentText,
    },
  };
}

export interface JoinPolicyEvent {
  status: string;
  access_mode: string;
  join_code: string | null;
  max_participants: number | null;
  activeCount: number;
}

export type JoinDecision = { ok: true } | { ok: false; code: string; message: string };

/** Pure join decision. Never leaks whether a join code exists or its value. */
export function evaluateJoinPolicy(event: JoinPolicyEvent, providedCode: unknown): JoinDecision {
  if (event.status !== 'active') {
    return { ok: false, code: 'event_not_active', message: 'Event is not open for joining' };
  }
  if (event.access_mode !== 'public') {
    const hasCode = typeof event.join_code === 'string' && event.join_code.length > 0;
    const matches = hasCode && typeof providedCode === 'string' && providedCode === event.join_code;
    if (!hasCode || !matches) {
      return { ok: false, code: 'join_forbidden', message: 'This event requires a valid join code or registration claim' };
    }
  }
  if (event.max_participants !== null && event.activeCount >= event.max_participants) {
    return { ok: false, code: 'event_full', message: 'Event has reached its participant limit' };
  }
  return { ok: true };
}

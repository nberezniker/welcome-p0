import type { Validated } from './profile';
import { CONTACT_KINDS } from './profile';

/** Introductions domain: canonical pairs, context keys, input validation.
 * State machine lives in the routes (transactional CAS against the DB).
 * A language choice, page view or link click is never consent — both parties
 * must explicitly respond with accept before anything is revealed. */

/** Fields that can be revealed after MUTUAL acceptance. The login email is
 * never stored in plaintext, so it can never be revealed. */
export const REVEAL_FIELDS = [...CONTACT_KINDS] as const;
export type RevealField = (typeof REVEAL_FIELDS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVEAL_FIELDS_MAX = 20;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Canonical pair: lexicographic min/max, so (a,b) and (b,a) are the same row. */
export function canonicalPair(profileId1: string, profileId2: string): { profileA: string; profileB: string } {
  return profileId1 < profileId2
    ? { profileA: profileId1, profileB: profileId2 }
    : { profileA: profileId2, profileB: profileId1 };
}

export function eventContextKey(eventId: string): string {
  return `event:${eventId}`;
}

/**
 * Personal context key. Interpretation ②: keyed by the MIN profile uuid of the
 * pair — otherwise idempotency of personal introductions would be impossible
 * (two strangers share no event or account to derive a stable key from).
 */
export function personalContextKey(profileId1: string, profileId2: string): string {
  return `personal:${canonicalPair(profileId1, profileId2).profileA}`;
}

export interface CreateIntroInput {
  targetProfileId: string;
  eventId: string | null;
  revealFields: RevealField[];
}

export function validateCreateIntroInput(body: unknown): Validated<CreateIntroInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;

  const targetProfileId = b.target_profile_id;
  if (typeof targetProfileId !== 'string' || !isUuid(targetProfileId)) {
    return { ok: false, code: 'invalid_target', message: 'target_profile_id must be a profile uuid' };
  }

  let eventId: string | null = null;
  if (b.event_id !== undefined && b.event_id !== null) {
    if (typeof b.event_id !== 'string' || !isUuid(b.event_id)) {
      return { ok: false, code: 'invalid_event_id', message: 'event_id must be an event uuid' };
    }
    eventId = b.event_id;
  }

  let revealFields: RevealField[] = [];
  if (b.reveal_fields !== undefined && b.reveal_fields !== null) {
    if (!Array.isArray(b.reveal_fields) || b.reveal_fields.length > REVEAL_FIELDS_MAX) {
      return { ok: false, code: 'invalid_reveal_fields', message: `reveal_fields must be an array (max ${REVEAL_FIELDS_MAX})` };
    }
    for (const f of b.reveal_fields) {
      if (typeof f !== 'string' || !(REVEAL_FIELDS as readonly string[]).includes(f)) {
        return { ok: false, code: 'invalid_reveal_fields', message: `reveal_fields must be a subset of: ${REVEAL_FIELDS.join(', ')}` };
      }
    }
    revealFields = [...new Set(b.reveal_fields as RevealField[])];
  }

  return { ok: true, value: { targetProfileId, eventId, revealFields } };
}

export type IntroDecision = 'accept' | 'decline' | 'withdraw';

export interface RespondIntroInput {
  decision: IntroDecision;
  revealFields: RevealField[];
}

export function validateRespondInput(body: unknown): Validated<RespondIntroInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;

  const decision = b.decision;
  if (decision !== 'accept' && decision !== 'decline' && decision !== 'withdraw') {
    return { ok: false, code: 'invalid_decision', message: 'decision must be accept, decline or withdraw' };
  }

  let revealFields: RevealField[] = [];
  if (b.reveal_fields !== undefined && b.reveal_fields !== null) {
    if (!Array.isArray(b.reveal_fields) || b.reveal_fields.length > REVEAL_FIELDS_MAX) {
      return { ok: false, code: 'invalid_reveal_fields', message: `reveal_fields must be an array (max ${REVEAL_FIELDS_MAX})` };
    }
    for (const f of b.reveal_fields) {
      if (typeof f !== 'string' || !(REVEAL_FIELDS as readonly string[]).includes(f)) {
        return { ok: false, code: 'invalid_reveal_fields', message: `reveal_fields must be a subset of: ${REVEAL_FIELDS.join(', ')}` };
      }
    }
    revealFields = [...new Set(b.reveal_fields as RevealField[])];
  }

  return { ok: true, value: { decision, revealFields } };
}

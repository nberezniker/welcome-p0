import type { Sql, TransactionSql } from 'postgres';
import type { OrganizerRole } from './organizer';
import type { Validated } from './profile';
import {
  validateIndustry,
  validateInterests,
  validateJobFunction,
  validateNeedIntents,
  validateOfferIntents,
} from './taxonomy';
import type { Validation } from './taxonomy';

/** Campaign row projection used by the organizer routes. */
export interface CampaignRow {
  id: string;
  event_id: string;
  organizer_id: string;
  purpose: CampaignPurpose;
  body_text: string | null;
  audience_filter: Record<string, unknown>;
  content_revision: number;
  approved_revision: number | null;
  state: CampaignState;
  queued_count: number;
  sent_count: number;
  created_at: Date;
}

/**
 * Loads a campaign with the caller's organizer role (LEFT JOIN — roles come
 * from organizer_members only). null when the campaign does not exist.
 * Callers MUST treat role=null as 404 (no existence leak across organizers).
 */
export async function loadCampaignWithRole(
  sql: Sql,
  accountId: string,
  campaignId: string,
): Promise<{ campaign: CampaignRow; role: OrganizerRole | null } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(campaignId)) return null;
  const rows = await sql<CampaignRow[]>`
    SELECT c.id, c.event_id, c.organizer_id, c.purpose, c.body_text, c.audience_filter,
           c.content_revision::int AS content_revision, c.approved_revision::int AS approved_revision,
           c.state, c.queued_count, c.sent_count, c.created_at
    FROM campaigns c
    WHERE c.id = ${campaignId}
    LIMIT 1
  `;
  const campaign = rows[0];
  if (!campaign) return null;
  const roleRows = await sql<{ role: OrganizerRole }[]>`
    SELECT role FROM organizer_members
    WHERE organizer_id = ${campaign.organizer_id} AND account_id = ${accountId}
    LIMIT 1
  `;
  return { campaign, role: roleRows[0]?.role ?? null };
}

/**
 * Organizer campaigns (spec 01 S08, 04 §7).
 * State machine: draft → approved → running → completed | cancelled.
 * Edit after approval resets the approval (AC-40): content_revision++,
 * approved_revision → NULL, state back to 'draft'. The audience snapshot
 * frozen at approve time NEVER bypasses a revoke — send re-validates
 * everything against the live DB (AC-41).
 */

export const CAMPAIGN_PURPOSES = ['organizer_marketing', 'service_channel'] as const;
export type CampaignPurpose = (typeof CAMPAIGN_PURPOSES)[number];

export function isCampaignPurpose(value: unknown): value is CampaignPurpose {
  return typeof value === 'string' && (CAMPAIGN_PURPOSES as readonly string[]).includes(value);
}

const BODY_MAX = 4000;
const AUDIENCE_FILTER_MAX_BYTES = 4096;

export interface CampaignCreateInput {
  eventId: string;
  purpose: CampaignPurpose;
  bodyText: string;
  audienceFilter: AudienceFilter;
}

// ---------------------------------------------------------------------------
// Audience segments (audience_filter)
// ---------------------------------------------------------------------------

/**
 * Which participants a campaign reaches, expressed in the taxonomy v3 axes.
 *
 * Every axis is OPTIONAL and an empty value means "no constraint": empty arrays
 * and null facets are dropped from the predicate, so the default filter (`{}`)
 * keeps the pre-segment behaviour — every eligible member of the event.
 *
 * Semantics per axis (mirroring the event directory, which reads the same axes
 * with the same membership-overrides-profile rule):
 *   - array axes: keep members whose EFFECTIVE value OVERLAPS the selection
 *     ("has any of these");
 *   - facet axes: keep members whose EFFECTIVE value EQUALS the selection.
 *
 * The `index signature` keeps unknown keys from older/newer clients intact
 * instead of rejecting the payload: the registry is additive, and the SQL only
 * ever reads the five known keys.
 */
export interface AudienceFilter {
  need_intents: string[];
  offer_intents: string[];
  interests: string[];
  job_function: string | null;
  industry: string | null;
  [key: string]: unknown;
}

export const AUDIENCE_FILTER_KEYS = ['need_intents', 'offer_intents', 'interests', 'job_function', 'industry'] as const;

export function emptyAudienceFilter(): AudienceFilter {
  return { need_intents: [], offer_intents: [], interests: [], job_function: null, industry: null };
}

/** True when the filter constrains nothing (an empty segment = everyone eligible). */
export function audienceFilterIsEmpty(filter: AudienceFilter): boolean {
  return (
    filter.need_intents.length === 0 &&
    filter.offer_intents.length === 0 &&
    filter.interests.length === 0 &&
    filter.job_function === null &&
    filter.industry === null
  );
}

/**
 * Validates and normalizes an `audience_filter` body field. Every id must exist
 * in the taxonomy v3 catalogue (the catalogue is the single source of truth for
 * the vocabulary), arrays are deduped, and `prefer-not-to-say` normalizes to
 * "no constraint" exactly as it does on a profile.
 *
 * Unknown keys are preserved verbatim rather than rejected — the column is
 * additive by design.
 */
export function validateAudienceFilter(raw: unknown): Validated<AudienceFilter> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'invalid_audience_filter', message: 'audience_filter must be an object' };
  }
  const b = raw as Record<string, unknown>;
  const checks: [string, Validation<string[]> | Validation<string | null>][] = [
    ['need_intents', validateNeedIntents(b['need_intents'])],
    ['offer_intents', validateOfferIntents(b['offer_intents'])],
    ['interests', validateInterests(b['interests'])],
    ['job_function', validateJobFunction(b['job_function'])],
    ['industry', validateIndustry(b['industry'])],
  ];
  const filter = emptyAudienceFilter();
  for (const [key, result] of checks) {
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    (filter as Record<string, unknown>)[key] = result.value;
  }
  for (const [key, value] of Object.entries(b)) {
    if (!(AUDIENCE_FILTER_KEYS as readonly string[]).includes(key)) filter[key] = value;
  }
  return { ok: true, value: filter };
}

/**
 * Reads a stored `audience_filter` (jsonb) back into the typed shape. Defensive:
 * a row written before a key existed — or by hand — must degrade to "no
 * constraint on that axis", never to a 500 on the audience endpoint.
 */
export function normalizeAudienceFilter(raw: unknown): AudienceFilter {
  const parsed = validateAudienceFilter(raw);
  return parsed.ok ? parsed.value : emptyAudienceFilter();
}

export function validateCampaignCreate(body: unknown): { ok: true; value: CampaignCreateInput } | { ok: false; code: string; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b['event_id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b['event_id'])) {
    return { ok: false, code: 'invalid_event_id', message: 'event_id must be an event uuid' };
  }
  if (!isCampaignPurpose(b['purpose'])) {
    return { ok: false, code: 'invalid_purpose', message: `purpose must be one of: ${CAMPAIGN_PURPOSES.join(', ')}` };
  }
  const bodyText = typeof b['body_text'] === 'string' ? b['body_text'].trim() : '';
  if (bodyText.length < 1 || bodyText.length > BODY_MAX) {
    return { ok: false, code: 'invalid_body_text', message: `body_text must be 1..${BODY_MAX} chars` };
  }
  let audienceFilter = emptyAudienceFilter();
  if (b['audience_filter'] !== undefined) {
    const parsed = validateAudienceFilter(b['audience_filter']);
    if (!parsed.ok) return parsed;
    audienceFilter = parsed.value;
  }
  return { ok: true, value: { eventId: b['event_id'], purpose: b['purpose'], bodyText, audienceFilter } };
}

export interface CampaignEditInput {
  purpose?: CampaignPurpose;
  bodyText?: string;
  audienceFilter?: AudienceFilter;
}

export function validateCampaignEdit(body: unknown): { ok: true; value: CampaignEditInput } | { ok: false; code: string; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;
  const value: CampaignEditInput = {};

  if (b['purpose'] !== undefined) {
    if (!isCampaignPurpose(b['purpose'])) {
      return { ok: false, code: 'invalid_purpose', message: `purpose must be one of: ${CAMPAIGN_PURPOSES.join(', ')}` };
    }
    value.purpose = b['purpose'];
  }
  if (b['body_text'] !== undefined) {
    const bodyText = typeof b['body_text'] === 'string' ? b['body_text'].trim() : '';
    if (bodyText.length < 1 || bodyText.length > BODY_MAX) {
      return { ok: false, code: 'invalid_body_text', message: `body_text must be 1..${BODY_MAX} chars` };
    }
    value.bodyText = bodyText;
  }
  if (b['audience_filter'] !== undefined) {
    if (typeof b['audience_filter'] !== 'object' || b['audience_filter'] === null || Array.isArray(b['audience_filter'])) {
      return { ok: false, code: 'invalid_audience_filter', message: 'audience_filter must be an object' };
    }
    if (JSON.stringify(b['audience_filter']).length > AUDIENCE_FILTER_MAX_BYTES) {
      return { ok: false, code: 'invalid_audience_filter', message: `audience_filter must serialize to ≤ ${AUDIENCE_FILTER_MAX_BYTES} bytes` };
    }
    const filter = validateAudienceFilter(b['audience_filter']);
    if (!filter.ok) return filter;
    value.audienceFilter = filter.value;
  }
  if (value.purpose === undefined && value.bodyText === undefined && value.audienceFilter === undefined) {
    return { ok: false, code: 'empty_edit', message: 'at least one of purpose, body_text, audience_filter is required' };
  }
  return { ok: true, value };
}

export type CampaignState = 'draft' | 'approved' | 'running' | 'completed' | 'cancelled';

export interface EditTransition {
  allowed: boolean;
  reason?: 'immutable_state';
  nextState: CampaignState;
  /** content_revision = current + 1 when content changed. */
  nextRevision: number;
  nextApprovedRevision: number | null;
}

/**
 * AC-40 (pure, unit-tested): any edit invalidates a prior approval.
 * draft/approved → revision++, approved_revision NULL, approved drops to draft.
 * running/completed/cancelled campaigns are immutable.
 */
export function campaignEditTransition(currentState: CampaignState, currentRevision: number): EditTransition {
  if (currentState === 'running' || currentState === 'completed' || currentState === 'cancelled') {
    return { allowed: false, reason: 'immutable_state', nextState: currentState, nextRevision: currentRevision, nextApprovedRevision: null };
  }
  return {
    allowed: true,
    nextState: currentState === 'approved' ? 'draft' : currentState,
    nextRevision: currentRevision + 1,
    nextApprovedRevision: null,
  };
}

/**
 * Send precondition (pure, unit-tested): sending requires state='approved'
 * AND approved_revision === content_revision — an edited campaign must be
 * re-approved before it can run.
 */
export function canSend(state: CampaignState, contentRevision: number, approvedRevision: number | null): boolean {
  return state === 'approved' && approvedRevision !== null && approvedRevision === contentRevision;
}

export interface AudienceMember {
  account_id: string;
  profile_id: string;
  display_name: string;
}

/**
 * CURRENTLY eligible audience for a campaign (live evaluation — the snapshot
 * is only a freeze of this query's result at approve time).
 *
 * Eligible = active members of the event with an active account whose LATEST
 * consent record for the campaign purpose at exact scope event:<id> is a
 * grant — minus blocked (either direction vs the campaign sender), minus
 * members with an open (unresolved) report — "reported-quarantined" — minus
 * explicitly revoked/blocked channel bindings. Members with NO binding stay
 * eligible: at send time their jobs are suppressed with code 'no_channel'
 * (documented P0 behaviour) or delivered by email (ADR 0011).
 *
 * organizer_marketing additionally requires directory_visible (privacy:
 * marketing reaches only members who opted into visibility); service_channel
 * does not.
 *
 * `filter` narrows the audience further to a saved segment (audience_filter).
 * Each axis is applied only when it constrains something, and the ACTIVE axes
 * are ANDed together; within an array axis the match is an overlap ("any of").
 * The effective value of every axis follows the directory rule — the
 * membership value wins when it is set, otherwise the profile value.
 */
export async function currentEligibleAudience(
  sql: Sql | TransactionSql,
  params: { eventId: string; purpose: CampaignPurpose; senderAccountId: string; filter?: AudienceFilter },
): Promise<AudienceMember[]> {
  const filter = params.filter ?? emptyAudienceFilter();
  return sql<AudienceMember[]>`
    SELECT pr.account_id, pr.id AS profile_id, pr.display_name
    FROM event_memberships m
    JOIN profiles pr ON pr.id = m.profile_id
    JOIN accounts a ON a.id = pr.account_id
    WHERE m.event_id = ${params.eventId}
      AND m.state = 'active'
      AND a.status = 'active'
      AND (${params.purpose} = 'service_channel' OR m.directory_visible = true)
      AND (
        SELECT ce.action FROM consent_events ce
        WHERE ce.account_id = a.id AND ce.purpose = ${params.purpose}
          AND ce.scope_type = 'event' AND ce.scope_id = ${params.eventId}
        ORDER BY ce.created_at DESC, ce.id DESC
        LIMIT 1
      ) = 'grant'
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.blocker_account_id = ${params.senderAccountId} AND b.target_account_id = a.id)
           OR (b.blocker_account_id = a.id AND b.target_account_id = ${params.senderAccountId})
      )
      AND NOT EXISTS (
        SELECT 1 FROM reports r WHERE r.target_account_id = a.id AND r.status = 'open'
      )
      AND NOT EXISTS (
        SELECT 1 FROM channel_bindings cb
        WHERE cb.account_id = a.id AND cb.provider = 'telegram' AND cb.state IN ('revoked', 'blocked')
      )
      AND (
        ${filter.need_intents}::text[] = '{}'
        OR COALESCE(NULLIF(m.need_intents, '{}'), pr.need_intents) && ${filter.need_intents}::text[]
      )
      AND (
        ${filter.offer_intents}::text[] = '{}'
        OR COALESCE(NULLIF(m.offer_intents, '{}'), pr.offer_intents) && ${filter.offer_intents}::text[]
      )
      AND (
        ${filter.interests}::text[] = '{}'
        OR COALESCE(NULLIF(m.interests, '{}'), pr.interests) && ${filter.interests}::text[]
      )
      AND (
        ${filter.job_function}::text IS NULL
        OR COALESCE(m.job_function, pr.job_function) = ${filter.job_function}
      )
      AND (
        ${filter.industry}::text IS NULL
        OR COALESCE(m.industry, pr.industry) = ${filter.industry}
      )
    ORDER BY pr.display_name ASC, pr.id ASC
  `;
}

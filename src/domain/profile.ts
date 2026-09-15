import { normalTags } from './matching';
import {
  validateIndustry,
  validateInterests,
  validateJobFunction,
  validateKeywords,
  validateNeedIntents,
  validateOfferIntents,
} from './taxonomy';
import { validateGoals, type GoalId } from './goals';

/** Pure profile input validation + optimistic-concurrency logic.
 * DB access stays in route handlers; this module is unit-testable. */

export interface ProfileInput {
  displayName: string;
  headline: string | null;
  company: string | null;
  shortBio: string | null;
  languages: string[];
  offerTags: string[];
  needTags: string[];
  /** Taxonomy v3 axes (additive; legacy tags stay for the frozen tag core). */
  needIntents: string[];
  offerIntents: string[];
  interests: string[];
  industry: string | null;
  jobFunction: string | null;
  keywords: string[];
  /** Card fields withheld from the public mini-landing (empty = all public). */
  hiddenFields: string[];
  /**
   * Private goals (migration 011, matching v4 §B2): ≤3 catalogue ids in the
   * user's priority order. Never published — see src/domain/goals.ts.
   */
  goals: GoalId[];
}

export type Validated<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function optString(body: Record<string, unknown>, key: string, maxLength: number): string | null | undefined {
  if (!(key in body) || body[key] === null || body[key] === undefined) return null;
  const v = body[key];
  if (typeof v !== 'string') return undefined; // signals invalid type
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) return undefined;
  return trimmed;
}

function normalizeLanguages(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > 10) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const v = item.trim().toLowerCase();
    if (v.length === 0 || v.length > 30) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Validates a POST /api/me/profile body. Tag rules come from the matching.mjs port. */
export function validateProfileInput(body: unknown): Validated<ProfileInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;

  const displayName = typeof b.display_name === 'string' ? b.display_name.trim() : '';
  if (displayName.length < 1 || displayName.length > 120) {
    return { ok: false, code: 'invalid_display_name', message: 'display_name is required (1..120 chars)' };
  }

  const headline = optString(b, 'headline', 200);
  if (headline === undefined) return { ok: false, code: 'invalid_headline', message: 'headline must be a string up to 200 chars' };
  const company = optString(b, 'company', 120);
  if (company === undefined) return { ok: false, code: 'invalid_company', message: 'company must be a string up to 120 chars' };
  const shortBio = optString(b, 'short_bio', 1000);
  if (shortBio === undefined) return { ok: false, code: 'invalid_short_bio', message: 'short_bio must be a string up to 1000 chars' };

  const languages = normalizeLanguages(b.languages ?? []);
  if (languages === null) return { ok: false, code: 'invalid_languages', message: 'languages must be an array of short strings (max 10)' };

  let offerTags: string[];
  let needTags: string[];
  try {
    offerTags = normalTags(b.offer_tags ?? []);
    needTags = normalTags(b.need_tags ?? []);
  } catch {
    return { ok: false, code: 'invalid_tags', message: 'offer_tags/need_tags must be an array of strings, each up to 80 chars' };
  }

  // Taxonomy v3 axes. Absent fields default to empty/null so existing clients and
  // pre-v3 rows keep validating unchanged; unknown catalogue ids are an error.
  const needIntents = validateNeedIntents(b.need_intents);
  if (!needIntents.ok) return { ok: false, code: needIntents.code, message: needIntents.message };
  const offerIntents = validateOfferIntents(b.offer_intents);
  if (!offerIntents.ok) return { ok: false, code: offerIntents.code, message: offerIntents.message };
  const interests = validateInterests(b.interests);
  if (!interests.ok) return { ok: false, code: interests.code, message: interests.message };
  const keywords = validateKeywords(b.keywords);
  if (!keywords.ok) return { ok: false, code: keywords.code, message: keywords.message };
  const industry = validateIndustry(b.industry);
  if (!industry.ok) return { ok: false, code: industry.code, message: industry.message };
  const jobFunction = validateJobFunction(b.job_function);
  if (!jobFunction.ok) return { ok: false, code: jobFunction.code, message: jobFunction.message };

  // Mini-landing card opt-outs (migration 008). Absent → empty = everything public.
  const hiddenFields = validateHiddenFields(b.hidden_fields);
  if (!hiddenFields.ok) return { ok: false, code: hiddenFields.code, message: hiddenFields.message };

  // Private goals (migration 011). Absent → empty; order is the user's priority.
  const goals = validateGoals(b.goals);
  if (!goals.ok) return { ok: false, code: goals.code, message: goals.message };

  return {
    ok: true,
    value: {
      displayName,
      headline,
      company,
      shortBio,
      languages,
      offerTags,
      needTags,
      needIntents: needIntents.value,
      offerIntents: offerIntents.value,
      interests: interests.value,
      industry: industry.value,
      jobFunction: jobFunction.value,
      keywords: keywords.value,
      hiddenFields: hiddenFields.value,
      goals: goals.value,
    },
  };
}

export type RevisionCheck =
  | { ok: true; nextRevision: number }
  | { ok: false; currentRevision: number };

/**
 * Optimistic concurrency for profiles.revision.
 * - missing/non-integer revision → 400 handled by caller (revision_required)
 * - revision !== current → conflict; caller responds 409 with currentRevision
 * - match → update is allowed and revision is bumped by 1
 */
export function checkRevision(
  current: number,
  requested: unknown,
): RevisionCheck {
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) {
    return { ok: false, currentRevision: current };
  }
  if (requested !== current) {
    return { ok: false, currentRevision: current };
  }
  return { ok: true, nextRevision: current + 1 };
}

/** Contacts: allowed kinds per P0 brief. Values are encrypted at rest.
 * `github_url` was added with the mini-landing (migration 008) — the design doc
 * lists GitHub as one of the link kinds the user confirms by hand. */
export const CONTACT_KINDS = ['whatsapp', 'telegram_username', 'linkedin_url', 'website', 'phone', 'github_url'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

/**
 * Profile fields that appear in the public mini-landing (migration 008
 * `profiles.hidden_fields`). A field listed there is withheld from the public
 * projection; contacts have their own per-row `public_enabled` flag and are NOT
 * part of this list.
 */
export const PUBLIC_FIELD_IDS = [
  'headline',
  'company',
  'short_bio',
  'languages',
  'offer_tags',
  'need_tags',
  'need_intents',
  'offer_intents',
  'interests',
  'keywords',
] as const;
export type PublicFieldId = (typeof PUBLIC_FIELD_IDS)[number];

export const MAX_HIDDEN_FIELDS = PUBLIC_FIELD_IDS.length;

/** Deny list of card fields: catalogue-validated ids, deduped, capped. */
export function validateHiddenFields(raw: unknown): Validated<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'invalid_hidden_fields', message: 'hidden_fields must be an array of field ids' };
  }
  if (raw.length > MAX_HIDDEN_FIELDS) {
    return {
      ok: false,
      code: 'invalid_hidden_fields',
      message: `at most ${MAX_HIDDEN_FIELDS} hidden_fields values are allowed`,
    };
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !(PUBLIC_FIELD_IDS as readonly string[]).includes(item)) {
      return {
        ok: false,
        code: 'invalid_hidden_fields',
        message: `hidden_fields must be a subset of: ${PUBLIC_FIELD_IDS.join(', ')}`,
      };
    }
    if (!out.includes(item)) out.push(item);
  }
  return { ok: true, value: out };
}

export interface ContactInput {
  kind: ContactKind;
  value: string;
  publicEnabled: boolean;
}

export function validateContactInput(body: unknown): Validated<ContactInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;
  const kind = b.kind;
  if (typeof kind !== 'string' || !(CONTACT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, code: 'invalid_kind', message: `kind must be one of: ${CONTACT_KINDS.join(', ')}` };
  }
  const value = typeof b.value === 'string' ? b.value.trim() : '';
  if (value.length < 1 || value.length > 300) {
    return { ok: false, code: 'invalid_value', message: 'value is required (1..300 chars)' };
  }
  const publicEnabled = b.public_enabled;
  if (typeof publicEnabled !== 'boolean') {
    return { ok: false, code: 'invalid_public_enabled', message: 'public_enabled must be a boolean' };
  }
  return {
    ok: true,
    value: { kind: kind as ContactKind, value, publicEnabled },
  };
}

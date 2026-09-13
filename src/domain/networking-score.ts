/**
 * Networking score v3 — the additive, explainable, deterministic scoring layer
 * (docs-internal/taxonomy/TAXONOMY_V3.md):
 *
 *   intentScore     = 1 if a need of A is complemented by an offer of B (or vice versa)
 *   interestOverlap = |A ∩ B| / max(1, min(|A|, |B|))
 *   functionMatch   = 1 on same function or a complementary pair (founder↔investor, sales↔marketing)
 *   industryMatch   = 1 on same industry
 *   score = round(100 * (0.45*intentScore + 0.35*interestOverlap + 0.12*functionMatch + 0.08*industryMatch))
 *
 * Visibility gate (prevents noise): show a pair only when
 *   intentScore === 1 OR interestOverlap >= 0.34 OR (functionMatch === 1 AND industryMatch === 1).
 *
 * The frozen tag core (`scorePair` in ./matching) is NOT touched: this module is
 * a strictly additive layer. A profile that has filled neither intents nor
 * interests is reported with `eligible: false` so callers keep routing it through
 * the legacy tag path instead of silently scoring it as zero.
 *
 * No LLM, no network, no inferred attributes, no private fields. Reasons are
 * STRUCTURAL (see ./reasons): a code plus the catalogue ids the sentence needs.
 * The domain never renders text — the UI does, through i18n, from the viewer's
 * point of view and in the viewer's language.
 */

import {
  COMPLEMENTARY_FUNCTIONS,
  complementOf,
  INTENTS,
  interestOrder,
  isIndustryId,
  isJobFunctionId,
  normalizeIntentTag,
  normalizeInterest,
} from './taxonomy';
import type { Reason } from './reasons';

export const NETWORKING_ALGORITHM = 'welcome_intent_interest_v1' as const;

/** Interest overlap at or above this level passes the visibility gate on its own. */
export const INTEREST_GATE = 0.34;

export interface NetworkingProfileInput {
  id: string;
  /** Server-side eligibility (active membership + directory/matching flags). */
  eligible?: boolean;
  blocked?: boolean;
  needIntents?: unknown;
  offerIntents?: unknown;
  interests?: unknown;
  industry?: unknown;
  jobFunction?: unknown;
}

export interface NetworkingScoreResult {
  readonly score: number;
  readonly intentScore: 0 | 1;
  readonly interestOverlap: number;
  readonly functionMatch: 0 | 1;
  readonly industryMatch: 0 | 1;
  /** false → this pair must be handled by the legacy tag path, never surfaced by v3. */
  readonly eligible: boolean;
  readonly algorithm: typeof NETWORKING_ALGORITHM;
  /** Relevance does not assert actual interest or acceptance by either side. */
  readonly mutualConsent: false;
  /** Structural reasons, from `a`'s point of view (see reasonsFor). */
  readonly reasons: readonly Reason[];
}

interface NormalizedProfile {
  needs: string[];
  offers: string[];
  interests: string[];
  industry: string | null;
  jobFunction: string | null;
}

// --- deterministic catalogue ordering -------------------------------------

const INTENT_INDEX = new Map<string, number>();
for (const pair of INTENTS) {
  INTENT_INDEX.set(pair.need.id, INTENT_INDEX.size);
  INTENT_INDEX.set(pair.offer.id, INTENT_INDEX.size);
}

function byIntentOrder(a: string, b: string): number {
  return (INTENT_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER) - (INTENT_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER);
}

// --- normalization ---------------------------------------------------------

/** Canonical, catalogue-ordered intent ids of one side (tolerates legacy tags). */
function normalizeIntentList(raw: unknown, kind: 'need' | 'offer'): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const id = normalizeIntentTag(item, kind);
    if (id && !out.includes(id)) out.push(id);
  }
  return out.sort(byIntentOrder);
}

function normalizeInterestList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const id = normalizeInterest(item);
    if (id && !out.includes(id)) out.push(id);
  }
  return out.sort((a, b) => interestOrder(a) - interestOrder(b) || (a < b ? -1 : 1));
}

function normalizeProfile(p: NetworkingProfileInput): NormalizedProfile {
  return {
    needs: normalizeIntentList(p.needIntents, 'need'),
    offers: normalizeIntentList(p.offerIntents, 'offer'),
    interests: normalizeInterestList(p.interests),
    industry: isIndustryId(p.industry) ? p.industry : null,
    jobFunction: isJobFunctionId(p.jobFunction) ? p.jobFunction : null,
  };
}

function hasV3Data(p: NormalizedProfile): boolean {
  return p.needs.length > 0 || p.offers.length > 0 || p.interests.length > 0;
}

function complementaryFunction(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return COMPLEMENTARY_FUNCTIONS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

/** Shared intent directions between two normalized profiles. */
function intentDirections(viewer: NormalizedProfile, other: NormalizedProfile) {
  const otherOfferedForMe = viewer.needs.filter((n) => {
    const offer = complementOf(n);
    return offer !== null && other.offers.includes(offer);
  });
  const iCanHelpOther = other.needs.filter((n) => {
    const offer = complementOf(n);
    return offer !== null && viewer.offers.includes(offer);
  });
  return { otherOfferedForMe, iCanHelpOther };
}

const EMPTY_RESULT: Omit<NetworkingScoreResult, 'algorithm'> = {
  score: 0,
  intentScore: 0,
  interestOverlap: 0,
  functionMatch: 0,
  industryMatch: 0,
  eligible: false,
  mutualConsent: false,
  reasons: [],
};

/**
 * Pure, deterministic score for a pair. Returns null on hard ineligibility
 * (same id, missing ids, not eligible, blocked) — never a numeric "0 match".
 */
export function scoreNetworking(
  a: NetworkingProfileInput,
  b: NetworkingProfileInput,
): NetworkingScoreResult | null {
  if (!a || !b || typeof a.id !== 'string' || typeof b.id !== 'string') throw new TypeError('Profile IDs required');
  if (a.id === b.id) return null;
  if (a.eligible !== true || b.eligible !== true || a.blocked === true || b.blocked === true) return null;

  const na = normalizeProfile(a);
  const nb = normalizeProfile(b);

  // Neither side carries v3 data → not this layer's business (legacy tags handle it).
  if (!hasV3Data(na) || !hasV3Data(nb)) {
    return Object.freeze({ ...EMPTY_RESULT, algorithm: NETWORKING_ALGORITHM });
  }

  const { otherOfferedForMe, iCanHelpOther } = intentDirections(na, nb);
  const intentScore: 0 | 1 = otherOfferedForMe.length > 0 || iCanHelpOther.length > 0 ? 1 : 0;

  const sharedInterests = na.interests.filter((i) => nb.interests.includes(i));
  const minInterests = Math.min(na.interests.length, nb.interests.length);
  const interestOverlap = minInterests > 0 ? sharedInterests.length / minInterests : 0;

  const sameFunction = na.jobFunction !== null && na.jobFunction === nb.jobFunction;
  const functionMatch: 0 | 1 = sameFunction || complementaryFunction(na.jobFunction, nb.jobFunction) ? 1 : 0;
  const industryMatch: 0 | 1 = na.industry !== null && na.industry === nb.industry ? 1 : 0;

  const score = Math.round(
    100 * (0.45 * intentScore + 0.35 * interestOverlap + 0.12 * functionMatch + 0.08 * industryMatch),
  );

  const eligible =
    intentScore === 1 || interestOverlap >= INTEREST_GATE || (functionMatch === 1 && industryMatch === 1);

  return Object.freeze({
    score,
    intentScore,
    interestOverlap,
    functionMatch,
    industryMatch,
    eligible,
    algorithm: NETWORKING_ALGORITHM,
    mutualConsent: false as const,
    reasons: reasonsFromNormalized(na, nb, sharedInterests, functionMatch, industryMatch),
  });
}

/**
 * Structural reasons for `other` as seen by `viewer`, in a stable order:
 *   1. your intents that they can cover, 2. their intents you can cover,
 *   3. shared interests, 4. shared function, 5. same industry.
 *
 * Deterministic and perspective-aware: swapping the arguments changes the
 * sentences (the reason list describes the SECOND argument from the point of
 * view of the FIRST). Look at reasonCodesFor() when you need codes only.
 */
export function reasonCodesFor(
  viewer: NetworkingProfileInput,
  other: NetworkingProfileInput,
): Reason[] {
  if (!viewer || !other || typeof viewer.id !== 'string' || typeof other.id !== 'string') return [];
  if (viewer.id === other.id) return [];
  const nv = normalizeProfile(viewer);
  const no = normalizeProfile(other);
  const shared = nv.interests.filter((i) => no.interests.includes(i));
  const sameFunction = nv.jobFunction !== null && nv.jobFunction === no.jobFunction;
  const functionMatch: 0 | 1 = sameFunction || complementaryFunction(nv.jobFunction, no.jobFunction) ? 1 : 0;
  const industryMatch: 0 | 1 = nv.industry !== null && nv.industry === no.industry ? 1 : 0;
  return reasonsFromNormalized(nv, no, shared, functionMatch, industryMatch);
}

/** Backwards-compatible name: reasons are structural, not localized text. */
export const reasonsFor = reasonCodesFor;

/** Max intent-level reasons; keeps the list short and predictable. */
const MAX_INTENT_REASONS = 3;

function reasonsFromNormalized(
  viewer: NormalizedProfile,
  other: NormalizedProfile,
  sharedInterests: string[],
  functionMatch: 0 | 1,
  industryMatch: 0 | 1,
): Reason[] {
  const reasons: Reason[] = [];

  for (const need of viewer.needs) {
    if (reasons.length >= MAX_INTENT_REASONS) break;
    const offer = complementOf(need);
    if (!offer || !other.offers.includes(offer)) continue;
    reasons.push({ code: 'intent_need_covered', params: { need, offer } });
  }
  for (const need of other.needs) {
    if (reasons.length >= MAX_INTENT_REASONS) break;
    const offer = complementOf(need);
    if (!offer || !viewer.offers.includes(offer)) continue;
    reasons.push({ code: 'intent_offer_match', params: { need, offer } });
  }

  if (sharedInterests.length > 0) {
    reasons.push({ code: 'shared_interests', params: { interests: [...sharedInterests] } });
  }
  if (functionMatch === 1 && viewer.jobFunction !== null) {
    reasons.push({ code: 'shared_function', params: { function: viewer.jobFunction } });
  }
  if (industryMatch === 1 && viewer.industry !== null) {
    reasons.push({ code: 'same_industry', params: { industry: viewer.industry } });
  }

  return reasons;
}

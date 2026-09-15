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

// ===========================================================================
// v4 — «usefulness»: goal-aligned, complementary, developmental (§B1/§B4)
//
// The v3 layer above answers "what do these two share?". v4 answers the two
// questions the product actually cares about: «закрывает ли этот человек мой
// запрос» и «полезны ли мы друг другу», with a goal in the loop and a penalty
// for echo chambers. It is strictly ADDITIVE: scoreNetworking/reasonCodesFor and
// the six v3 REASON_CODES above are untouched, the frozen tag core is untouched,
// and a pair that v4 cannot judge simply stays on the v3 path.
//
//   usefulness = 0.30·intentFit + 0.20·interestOverlap + 0.25·complementarity
//              + 0.15·goalAlignment + 0.10·novelty            (mode = 'useful')
//
// Two rules of the design are encoded as positions, not as comments:
//   - `recency` is a TIE-BREAKER only — it never appears in the formula, because
//     an old-but-useful person must not outrank a recent-but-useless one;
//   - `novelty` is computed against the items ALREADY picked in this list, so
//     the ranking is a greedy pass, not a per-pair sort.
// ===========================================================================

import { GOALS, isGoalId, type GoalDef } from './goals';
import { buildGrowthReasons, buildUsefulReasons, type ReasonV4, type ReasonV4Facts } from './reasons-v4';

export const NETWORKING_ALGORITHM_V4 = 'welcome_usefulness_v4' as const;

export type RecommendationMode = 'useful' | 'grow' | 'similar' | 'explore';

/** Mode order is the UI order of the switcher. */
export const RECOMMENDATION_MODES: readonly RecommendationMode[] = Object.freeze([
  'useful',
  'grow',
  'similar',
  'explore',
]);

export const DEFAULT_RECOMMENDATION_MODE: RecommendationMode = 'useful';

export function isRecommendationMode(value: unknown): value is RecommendationMode {
  return typeof value === 'string' && (RECOMMENDATION_MODES as readonly string[]).includes(value);
}

/**
 * Function pairs that are USEFUL to each other (§B1). Deliberately a v4
 * catalogue: the v3 `COMPLEMENTARY_FUNCTIONS` (founder↔investor,
 * sales↔marketing) is frozen and keeps driving the v3 score unchanged.
 */
export const V4_COMPLEMENTARY_FUNCTIONS: readonly (readonly [string, string])[] = Object.freeze([
  ['founder-ceo', 'investor'],
  ['design', 'engineering'],
  ['sales-bd', 'product'],
  ['product', 'engineering'],
  ['marketing', 'sales-bd'],
  ['hr-people', 'operations'],
]);

/** A pair must be useful to each other at least this much to enter the list. */
export const COMPLEMENTARITY_THRESHOLD = 0.25;

/** Offers that mean "I can teach you something". */
export const TEACHING_OFFERS: readonly string[] = Object.freeze([
  'mentoring',
  'advising',
  'open-to-project',
  'pilot-ready',
  'offering-feedback',
]);

/** Needs that mean "I am looking for exactly the help you can give". */
export const HELPABLE_NEEDS: readonly string[] = Object.freeze([
  'seeking-mentor',
  'seeking-expertise',
  'seeking-feedback',
]);

export interface UsefulnessComponents {
  /** 0..1 — the viewer's needs covered by the candidate, weighted by priority. */
  readonly intentFit: number;
  /** 0..1 — |shared| / max(1, min(|mine|, |theirs|)) (same rule as v3). */
  readonly interestOverlap: number;
  /** 0..1 — complementary functions and/or mutual needs×offers. */
  readonly complementarity: number;
  /** 0..1 — how much the candidate advances the viewer's own goals. */
  readonly goalAlignment: number;
  /** 0..1 — 1 for the first item, then 1 − similarity to the closest shown one. */
  readonly novelty: number;
  /** Supporting facts (never weighted on their own). */
  readonly matrixComplement: 0 | 1;
  readonly functionMatch: 0 | 1;
  readonly industryMatch: 0 | 1;
  readonly sameFunction: boolean;
  readonly learningFit: number;
  /** The candidate declared a function/industry at all (see outsideFit). */
  readonly otherHasFunction: boolean;
  readonly otherHasIndustry: boolean;
}

export interface UsefulnessProfileInput extends NetworkingProfileInput {
  /** Private goals (migration 011), priority order. */
  goals?: unknown;
  /** Epoch ms of the last relevant signal — tie-breaker ONLY (see header). */
  recency?: number | null;
}

export interface UsefulnessScoreResult {
  readonly eligible: boolean;
  readonly score: number;
  readonly components: UsefulnessComponents;
  readonly reasons_useful: readonly ReasonV4[];
  readonly reasons_growth: readonly ReasonV4[];
  readonly algorithm: typeof NETWORKING_ALGORITHM_V4;
  readonly mode: RecommendationMode;
  /** Why the caller's mode dropped this pair; null when it did not. */
  readonly excluded_reason: V4ExclusionReason | null;
}

export type V4ExclusionReason = 'no_candidates' | 'gate_not_met' | 'no_shared_topic';

/** Iteration order of the greedy pass: score, then recency, then id. */
export interface RankedItem {
  readonly id: string;
  readonly score: number;
  readonly mode: RecommendationMode;
  readonly algorithm: typeof NETWORKING_ALGORITHM_V4;
  readonly components: UsefulnessComponents;
  readonly reasons_useful: readonly ReasonV4[];
  readonly reasons_growth: readonly ReasonV4[];
}

export interface RankResult {
  readonly items: readonly RankedItem[];
  /** Candidates this mode's gate rejected (they were eligible to be looked at). */
  readonly excluded_count: number;
  /** `null` whenever at least one item came back. */
  readonly excluded_reason: V4ExclusionReason | null;
}

interface NormalizedUsefulnessProfile extends NormalizedProfile {
  id: string;
  goals: readonly GoalDef[];
  recency: number | null;
}

function normalizeUsefulnessProfile(p: UsefulnessProfileInput): NormalizedUsefulnessProfile {
  const base = normalizeProfile(p);
  const rawGoals = Array.isArray(p.goals) ? p.goals : [];
  const goals: GoalDef[] = [];
  for (const item of rawGoals) {
    if (!isGoalId(item)) continue;
    const goal = GOALS.find((g) => g.id === item);
    if (goal && !goals.includes(goal)) goals.push(goal);
  }
  return {
    ...base,
    id: p.id,
    goals,
    recency: typeof p.recency === 'number' && Number.isFinite(p.recency) ? p.recency : null,
  };
}

/** Harmonic priority weights: 1, 1/2, 1/3 … (the list order IS the priority). */
function priorityWeight(index: number): number {
  return 1 / (index + 1);
}

/** Share of `needs` covered, weighted by their position in the list. */
function weightedCoverage(needs: readonly string[], covers: (need: string) => boolean): number {
  if (needs.length === 0) return 0;
  let hit = 0;
  let total = 0;
  needs.forEach((need, index) => {
    const weight = priorityWeight(index);
    total += weight;
    if (covers(need)) hit += weight;
  });
  return total > 0 ? hit / total : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function isComplementaryPair(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return V4_COMPLEMENTARY_FUNCTIONS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

interface CrossFacts {
  needsCovered: string[];
  mutualNeeds: string[];
  sharedInterests: string[];
  goalsAdvanced: string[];
  teachableOffers: string[];
  helpableNeeds: string[];
}

/** Everything the reason builders and the components need, computed once. */
function crossFacts(viewer: NormalizedUsefulnessProfile, other: NormalizedUsefulnessProfile): CrossFacts {
  const needsCovered = viewer.needs.filter((need) => {
    const offer = complementOf(need);
    return offer !== null && other.offers.includes(offer);
  });
  const mutualNeeds = other.needs.filter((need) => {
    const offer = complementOf(need);
    return offer !== null && viewer.offers.includes(offer);
  });
  const sharedInterests = viewer.interests.filter((i) => other.interests.includes(i));
  const goalsAdvanced = viewer.goals
    .filter((goal) => goalScore(goal, other) === 1)
    .map((goal) => goal.id);
  const teachableOffers = other.offers.filter((offer) => TEACHING_OFFERS.includes(offer));
  const helpableNeeds = other.needs.filter((need) => {
    if (!HELPABLE_NEEDS.includes(need)) return false;
    const offer = complementOf(need);
    return offer !== null && viewer.offers.includes(offer);
  });
  return { needsCovered, mutualNeeds, sharedInterests, goalsAdvanced, teachableOffers, helpableNeeds };
}

/** How much one goal of the viewer is advanced by the candidate: 0 / 0.5 / 1. */
function goalScore(goal: GoalDef, other: NormalizedProfile): number {
  const { pattern } = goal;
  if (pattern.candidateOffers.some((offer) => other.offers.includes(offer))) return 1;
  if (pattern.candidateNeeds.some((need) => other.needs.includes(need))) return 1;
  if (pattern.interests.some((interest) => other.interests.includes(interest))) return 0.5;
  // A deliberately broad goal ("grow my network") is served by anyone who
  // bothered to fill a profile — it must not read as a zero.
  return pattern.broad === true ? 0.5 : 0;
}

/** Priority-weighted goal alignment across the viewer's own goals. */
function goalAlignmentOf(viewer: NormalizedUsefulnessProfile, other: NormalizedProfile): number {
  if (viewer.goals.length === 0) return 0;
  let hit = 0;
  let total = 0;
  viewer.goals.forEach((goal, index) => {
    const weight = priorityWeight(index);
    total += weight;
    hit += weight * goalScore(goal, other);
  });
  return total > 0 ? hit / total : 0;
}

/** Similarity between two candidates, used by the novelty penalty only. */
function candidateSimilarity(a: NormalizedProfile, b: NormalizedProfile): number {
  const sameFunction = a.jobFunction !== null && a.jobFunction === b.jobFunction ? 1 : 0;
  const sameIndustry = a.industry !== null && a.industry === b.industry ? 1 : 0;
  const union = new Set([...a.interests, ...b.interests]);
  const shared = a.interests.filter((i) => b.interests.includes(i)).length;
  const jaccard = union.size > 0 ? shared / union.size : 0;
  return clamp01(0.4 * sameFunction + 0.3 * sameIndustry + 0.3 * jaccard);
}

interface RawComponents {
  intentFit: number;
  interestOverlap: number;
  complementarity: number;
  goalAlignment: number;
  matrixComplement: 0 | 1;
  functionMatch: 0 | 1;
  industryMatch: 0 | 1;
  sameFunction: boolean;
  learningFit: number;
  otherHasFunction: boolean;
  otherHasIndustry: boolean;
  facts: CrossFacts;
}

function rawComponents(
  viewer: NormalizedUsefulnessProfile,
  other: NormalizedUsefulnessProfile,
): RawComponents {
  const facts = crossFacts(viewer, other);

  // intentFit — "does this person close MY request", my top need weighing most.
  const intentFit = weightedCoverage(viewer.needs, (need) => facts.needsCovered.includes(need));

  const minInterests = Math.min(viewer.interests.length, other.interests.length);
  const interestOverlap = minInterests > 0 ? facts.sharedInterests.length / minInterests : 0;

  // complementarity — the usefulness of the asymmetry, from either signal:
  //   · the function pair is complementary (founder↔investor, design↔engineering …);
  //   · or needs meet offers, measured in the BETTER of the two directions —
  //     covering the viewer's only request must count as much as covering one of
  //     three, because "закрывает мой запрос" is the point, not the volume.
  const matrixComplement: 0 | 1 = isComplementaryPair(viewer.jobFunction, other.jobFunction) ? 1 : 0;
  const forward = viewer.needs.length > 0 ? facts.needsCovered.length / viewer.needs.length : 0;
  const backward = other.needs.length > 0 ? facts.mutualNeeds.length / other.needs.length : 0;
  const complementarity = clamp01(Math.max(matrixComplement, forward, backward));

  const sameFunction = viewer.jobFunction !== null && viewer.jobFunction === other.jobFunction;
  const functionMatch: 0 | 1 = sameFunction || isComplementaryPair(viewer.jobFunction, other.jobFunction) ? 1 : 0;
  const industryMatch: 0 | 1 = viewer.industry !== null && viewer.industry === other.industry ? 1 : 0;

  return {
    intentFit,
    interestOverlap,
    complementarity,
    goalAlignment: goalAlignmentOf(viewer, other),
    matrixComplement,
    functionMatch,
    industryMatch,
    sameFunction,
    learningFit: facts.teachableOffers.length > 0 ? 1 : 0,
    otherHasFunction: other.jobFunction !== null,
    otherHasIndustry: other.industry !== null,
    facts,
  };
}

/**
 * Mode weights. `useful` is the documented default; the others re-weight the
 * same components for the other three questions of §B4. Each row must sum to 1
 * (the unit suite asserts it).
 */
export interface ModeWeights {
  readonly intentFit: number;
  readonly interestOverlap: number;
  readonly complementarity: number;
  readonly goalAlignment: number;
  /** The mode's own component (absent for `useful`). */
  readonly focus: { readonly key: 'learningFit' | 'peerFit' | 'outsideFit'; readonly weight: number } | null;
  readonly novelty: number;
}

export const V4_MODE_WEIGHTS: Record<RecommendationMode, ModeWeights> = Object.freeze({
  useful: { intentFit: 0.3, interestOverlap: 0.2, complementarity: 0.25, goalAlignment: 0.15, focus: null, novelty: 0.1 },
  grow: {
    intentFit: 0.3,
    interestOverlap: 0.15,
    complementarity: 0.2,
    goalAlignment: 0.15,
    focus: { key: 'learningFit', weight: 0.1 },
    novelty: 0.1,
  },
  // "Like me": the peer component must dominate, otherwise a teacher who
  // happens to close a request wins a list that is not about requests.
  similar: {
    intentFit: 0.05,
    interestOverlap: 0.3,
    complementarity: 0.05,
    goalAlignment: 0.05,
    focus: { key: 'peerFit', weight: 0.35 },
    novelty: 0.2,
  },
  explore: {
    intentFit: 0.05,
    interestOverlap: 0.2,
    complementarity: 0.05,
    goalAlignment: 0.05,
    focus: { key: 'outsideFit', weight: 0.35 },
    novelty: 0.3,
  },
});

/** Peer-networking fit: same function and/or industry. */
function peerFit(c: { functionMatch: 0 | 1; industryMatch: 0 | 1 }): number {
  return clamp01(0.5 * c.functionMatch + 0.5 * c.industryMatch);
}

/**
 * "Wider circle": a DIFFERENT but DECLARED function and/or industry. An empty
 * profile is not "outside the circle" — treating missing data as novelty would
 * push every half-filled profile to the top of the explore list.
 */
function outsideFit(c: {
  functionMatch: 0 | 1;
  industryMatch: 0 | 1;
  otherHasFunction: boolean;
  otherHasIndustry: boolean;
}): number {
  const differentFunction = c.otherHasFunction && c.functionMatch === 0 ? 1 : 0;
  const differentIndustry = c.otherHasIndustry && c.industryMatch === 0 ? 1 : 0;
  return clamp01(0.5 * differentFunction + 0.5 * differentIndustry);
}

/** usefulness for one mode, in [0,1]. The only place the weights are applied. */
export function usefulnessScore(
  mode: RecommendationMode,
  components: Pick<
    UsefulnessComponents,
    | 'intentFit'
    | 'interestOverlap'
    | 'complementarity'
    | 'goalAlignment'
    | 'novelty'
    | 'functionMatch'
    | 'industryMatch'
    | 'learningFit'
    | 'otherHasFunction'
    | 'otherHasIndustry'
  >,
): number {
  const w = V4_MODE_WEIGHTS[mode];
  let score =
    w.intentFit * components.intentFit +
    w.interestOverlap * components.interestOverlap +
    w.complementarity * components.complementarity +
    w.goalAlignment * components.goalAlignment +
    w.novelty * components.novelty;
  if (w.focus) {
    const focusValue =
      w.focus.key === 'learningFit'
        ? components.learningFit
        : w.focus.key === 'peerFit'
          ? peerFit(components)
          : outsideFit(components);
    score += w.focus.weight * focusValue;
  }
  return clamp01(score);
}

/**
 * Gate per mode (§B1 «гейт v3 + complementarity ≥ порог» for `useful`; the other
 * modes ask a different question, so they gate on their own component instead of
 * on mutual usefulness).
 */
export function modeGate(
  mode: RecommendationMode,
  raw: {
    components: Pick<
      UsefulnessComponents,
      'intentFit' | 'interestOverlap' | 'complementarity' | 'goalAlignment' | 'functionMatch' | 'industryMatch' | 'learningFit'
    >;
    v3Eligible: boolean;
    sharedInterests: number;
  },
): boolean {
  switch (mode) {
    case 'useful':
      return raw.v3Eligible && raw.components.complementarity >= COMPLEMENTARITY_THRESHOLD;
    case 'grow':
      // Someone to learn from: they offer teaching, or they serve one of my goals.
      return (
        raw.components.learningFit > 0 ||
        raw.components.goalAlignment > 0 ||
        raw.components.interestOverlap > 0
      );
    case 'similar':
      return (
        raw.components.interestOverlap > 0 ||
        raw.components.functionMatch === 1 ||
        raw.components.industryMatch === 1
      );
    case 'explore':
      // "Wider circle" still needs a shared topic — otherwise it is noise.
      return raw.sharedInterests > 0;
  }
}

/** The declared components of a scored pair, without the internal cross-facts. */
function publicComponents(raw: RawComponents): Omit<UsefulnessComponents, 'novelty'> {
  return {
    intentFit: raw.intentFit,
    interestOverlap: raw.interestOverlap,
    complementarity: raw.complementarity,
    goalAlignment: raw.goalAlignment,
    matrixComplement: raw.matrixComplement,
    functionMatch: raw.functionMatch,
    industryMatch: raw.industryMatch,
    sameFunction: raw.sameFunction,
    learningFit: raw.learningFit,
    otherHasFunction: raw.otherHasFunction,
    otherHasIndustry: raw.otherHasIndustry,
  };
}

/** Two-line explanation for one scored pair. */
function v4ReasonsFor(
  viewer: NormalizedUsefulnessProfile,
  other: NormalizedUsefulnessProfile,
  raw: RawComponents,
): { useful: ReasonV4[]; growth: ReasonV4[] } {
  const facts: ReasonV4Facts = {
    goalsAdvanced: raw.facts.goalsAdvanced,
    needsCovered: raw.facts.needsCovered,
    mutualNeeds: raw.facts.mutualNeeds,
    sharedInterests: raw.facts.sharedInterests,
    complementaryFunctions:
      raw.matrixComplement === 1 && viewer.jobFunction && other.jobFunction
        ? [viewer.jobFunction, other.jobFunction]
        : null,
    sameFunction: raw.sameFunction ? viewer.jobFunction : null,
    sameIndustry: raw.industryMatch === 1 ? viewer.industry : null,
    teachableOffers: raw.facts.teachableOffers,
    helpableNeeds: raw.facts.helpableNeeds,
    outsideCircle: raw.functionMatch === 0 && raw.industryMatch === 0,
    differentContext:
      raw.industryMatch === 0 && other.industry && viewer.industry !== other.industry
        ? { kind: 'industry', id: other.industry }
        : raw.functionMatch === 0 && other.jobFunction && viewer.jobFunction !== other.jobFunction
          ? { kind: 'function', id: other.jobFunction }
          : null,
  };
  return { useful: buildUsefulReasons(facts), growth: buildGrowthReasons(facts) };
}

/**
 * Ranks candidates for one viewer in one mode. Pure, deterministic and total:
 *
 *   1. a pair is judged by rawComponents (no state);
 *   2. pairs the mode's gate rejects are counted, not returned;
 *   3. survivors are picked GREEDILY by usefulness, because `novelty` depends on
 *      what has already been picked (the first pick has full novelty);
 *   4. ties break on `recency` and then on id — `recency` never enters the score.
 */
export function rankCandidates(
  viewerInput: UsefulnessProfileInput,
  candidateInputs: readonly UsefulnessProfileInput[],
  mode: RecommendationMode = DEFAULT_RECOMMENDATION_MODE,
  limit = 3,
): RankResult {
  if (typeof viewerInput?.id !== 'string') throw new TypeError('viewer id required');
  const viewer = normalizeUsefulnessProfile(viewerInput);
  const cap = Math.max(0, Math.floor(limit));

  const pool: { profile: NormalizedUsefulnessProfile; raw: RawComponents; v3: NetworkingScoreResult | null }[] = [];
  let considered = 0;
  let excluded = 0;

  for (const candidateInput of candidateInputs) {
    if (!candidateInput || typeof candidateInput.id !== 'string') continue;
    if (candidateInput.id === viewerInput.id) continue;
    if (candidateInput.eligible !== true || candidateInput.blocked === true) continue;
    considered += 1;

    const other = normalizeUsefulnessProfile(candidateInput);
    const raw = rawComponents(viewer, other);
    const v3 = scoreNetworking(viewerInput, candidateInput);
    const v3Eligible = v3 !== null && v3.eligible;
    const sharedInterests = raw.facts.sharedInterests.length;

    const gated = modeGate(mode, { components: raw, v3Eligible, sharedInterests });
    if (!gated) {
      excluded += 1;
      continue;
    }
    pool.push({ profile: other, raw, v3 });
  }

  const items: RankedItem[] = [];
  const picked: NormalizedUsefulnessProfile[] = [];

  while (pool.length > 0 && items.length < cap) {
    let bestIndex = -1;
    let bestScore = -1;

    for (let index = 0; index < pool.length; index++) {
      const entry = pool[index]!;
      const novelty =
        picked.length === 0
          ? 1
          : 1 - Math.max(...picked.map((shown) => candidateSimilarity(entry.profile, shown)));
      const components: UsefulnessComponents = { ...publicComponents(entry.raw), novelty };
      const score = Math.round(100 * usefulnessScore(mode, components));

      if (
        bestIndex === -1 ||
        score > bestScore ||
        (score === bestScore && tieBreak(entry.profile, pool[bestIndex]!.profile))
      ) {
        bestIndex = index;
        bestScore = score;
      }
    }

    const chosen = pool.splice(bestIndex, 1)[0]!;
    picked.push(chosen.profile);
    const novelty =
      picked.length === 1
        ? 1
        : 1 - Math.max(...picked.slice(0, -1).map((shown) => candidateSimilarity(chosen.profile, shown)));
    const reasons = v4ReasonsFor(viewer, chosen.profile, chosen.raw);
    items.push({
      id: chosen.profile.id,
      score: bestScore,
      mode,
      algorithm: NETWORKING_ALGORITHM_V4,
      components: { ...publicComponents(chosen.raw), novelty },
      reasons_useful: reasons.useful,
      reasons_growth: reasons.growth,
    });
  }

  return {
    items,
    excluded_count: excluded,
    excluded_reason:
      items.length > 0 ? null : considered === 0 ? 'no_candidates' : mode === 'explore' ? 'no_shared_topic' : 'gate_not_met',
  };
}

/** Recency first, then id — the documented tie-breakers (never in the formula). */
function tieBreak(a: NormalizedUsefulnessProfile, b: NormalizedUsefulnessProfile): boolean {
  const ra = a.recency ?? Number.NEGATIVE_INFINITY;
  const rb = b.recency ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return ra > rb;
  return a.id < b.id;
}

/**
 * TS port of the pure core from spec/contracts/matching.mjs.
 * Semantics must stay EXACTLY the same as the .mjs original (parity-tested
 * against the original file in tests/unit/matching-parity.test.ts).
 * No LLM, external calls, inferred sensitive attributes, or private contact fields.
 */

/** Trim, lowercase, dedupe; reject >80 chars and non-strings. Original semantics preserved. */
export function normalTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('Tags must be an array');
  return [
    ...new Set(
      value
        .map((x) => {
          if (typeof x !== 'string' || x.length > 80) throw new TypeError('Invalid tag');
          return x.trim().toLowerCase();
        })
        .filter(Boolean),
    ),
  ];
}

/** vCard text escaping: backslash first, then CRLF/CR/LF → \n, then ; and , . Original semantics preserved. */
export function escapeVCard(value: unknown): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

// ---------------------------------------------------------------------------
// scorePair / recommend / canRevealPrivate — frozen 1:1 port (Phase 2)
// ---------------------------------------------------------------------------

export interface MatchProfileInput {
  id: string;
  eligible?: boolean;
  blocked?: boolean;
  needs: unknown;
  offers: unknown;
}

export interface ScorePairResult {
  readonly score: number;
  readonly reasonsForA: string[];
  readonly reasonsForB: string[];
  readonly algorithm: 'welcome_mutual_tags_v1';
  /** Relevance does not assert actual interest or acceptance by either side. */
  readonly mutualConsent: false;
}

export function scorePair(a: MatchProfileInput, b: MatchProfileInput): ScorePairResult | null {
  if (!a || !b || typeof a.id !== 'string' || typeof b.id !== 'string') throw new TypeError('Profile IDs required');
  if (a.id === b.id) return null;
  if (a.eligible !== true || b.eligible !== true || a.blocked === true || b.blocked === true) return null;
  const an = normalTags(a.needs);
  const ao = normalTags(a.offers);
  const bn = normalTags(b.needs);
  const bo = normalTags(b.offers);
  const reasonsForA = an.filter((t) => bo.includes(t));
  const reasonsForB = bn.filter((t) => ao.includes(t));
  const dAB = reasonsForA.length / Math.max(1, an.length);
  const dBA = reasonsForB.length / Math.max(1, bn.length);
  if (!dAB || !dBA) return null;
  return Object.freeze({
    score: Math.round(100 * (0.6 * Math.min(dAB, dBA) + (0.4 * (dAB + dBA)) / 2)),
    reasonsForA,
    reasonsForB,
    algorithm: 'welcome_mutual_tags_v1' as const,
    // Relevance does not assert actual interest or acceptance by either side.
    mutualConsent: false as const,
  });
}

export interface CandidateInput extends MatchProfileInput {
  pending?: unknown;
}

export interface RecommendedItem {
  id: string;
  pending: number;
  match: ScorePairResult;
}

export function recommend(me: MatchProfileInput, candidates: CandidateInput[], limit = 3): RecommendedItem[] {
  if (!Array.isArray(candidates) || !Number.isInteger(limit) || limit < 0 || limit > 3) throw new TypeError('Limit must be 0..3');
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .map((c) => ({ id: c.id, pending: Math.max(0, Number(c.pending) || 0), match: scorePair(me, c) }))
    .filter((x): x is RecommendedItem => x.match !== null)
    .sort((a, b) => b.match.score - a.match.score || a.pending - b.pending || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit);
}

/**
 * CONTRACT-level reveal check (spec/contracts shape: state 'mutually_accepted').
 * The WELCOME DB state machine uses 'mutual'; the introductions route performs
 * the equivalent check with DB columns — this helper stays 1:1 with the .mjs
 * contract for parity testing.
 */
export function canRevealPrivate(
  intro: {
    state?: unknown;
    aAccepted?: unknown;
    bAccepted?: unknown;
    revoked?: unknown;
    consentVersion?: unknown;
  } | null | undefined,
  currentPolicy: { allowed?: unknown; consentVersion?: unknown } | null | undefined,
): boolean {
  return (
    intro?.state === 'mutually_accepted' &&
    intro.aAccepted === true &&
    intro.bAccepted === true &&
    intro.revoked !== true &&
    currentPolicy?.allowed === true &&
    intro.consentVersion === currentPolicy.consentVersion
  );
}

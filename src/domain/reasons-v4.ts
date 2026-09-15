/**
 * Vocabulary for the v4 «usefulness» reasons — the TWO-LINE explanation of a
 * recommendation (`docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md` §B3):
 *
 *   Польза:   «Закрывает твою цель „войти в EU-рынок“ · она в retail в Испании · вы оба в AI»
 *   Развитие: «Можешь научиться: RAG-системы (её сильная сторона — твой интерес)»
 *
 * The v3 codes (src/domain/reasons.ts, REASON_CODES) are NOT touched: they keep
 * describing the intent/interest/function axes for the legacy and v3 paths. v4
 * adds a SEPARATE dictionary, because a usefulness sentence answers a different
 * question ("why is this person good for me?") than a fact sentence ("what do
 * we share?"), and mixing the two vocabularies would make the two lines drift.
 *
 * A reason is still structural — a code plus the catalogue ids the sentence
 * needs — so the domain renders nothing and the UI localizes everything into
 * EN/RU/ES. The split into `useful` and `growth` IS the two-line design: a code
 * belongs to exactly one line, so the lines can never be swapped or duplicated.
 */

/** Line 1 — «Польза»: what this person does for the viewer's goal. */
export const USEFUL_REASON_CODES = [
  /** The candidate's offers/needs advance the viewer's goal. params: goal. */
  'goal_advanced',
  /** The viewer's top-priority need is covered (priority-weighted). params: need. */
  'need_covered',
  /** The candidate also needs something the viewer offers. params: need. */
  'mutual_needs',
  /** Overlap on the curated interest catalogue. params: interests[]. */
  'shared_interests',
  /** Functions form a complementary pair. params: mine, theirs. */
  'complementary_functions',
  /** Same or overlapping professional context. params: function | industry. */
  'same_context',
  /** The candidate's profile fits the mode the viewer asked for. params: mode. */
  'peer_context',
] as const;

/** Line 2 — «Развитие»: what the viewer can learn or give. */
export const GROWTH_REASON_CODES = [
  /** The candidate's strong side matches an interest the viewer wants to learn. params: offer. */
  'can_teach',
  /** The candidate is looking for exactly the help the viewer can give. params: need. */
  'wants_your_help',
  /** The candidate comes from outside the viewer's circle (novelty). params: none. */
  'outside_circle',
  /** A different industry/function that still shares a topic. params: industry|function. */
  'different_context',
] as const;

export type UsefulReasonCode = (typeof USEFUL_REASON_CODES)[number];
export type GrowthReasonCode = (typeof GROWTH_REASON_CODES)[number];
export type ReasonV4Code = UsefulReasonCode | GrowthReasonCode;

export type ReasonV4Line = 'useful' | 'growth';

export interface ReasonV4 {
  readonly code: ReasonV4Code;
  readonly params: Readonly<Record<string, string | readonly string[]>>;
}

/** True for the codes of line 1 (used by tests and the renderer). */
export function isUsefulCode(code: ReasonV4Code): code is UsefulReasonCode {
  return (USEFUL_REASON_CODES as readonly string[]).includes(code);
}

/** Which line a code belongs to — one answer, never two. */
export function lineOf(code: ReasonV4Code): ReasonV4Line {
  return isUsefulCode(code) ? 'useful' : 'growth';
}

/** i18n templates per line, keyed by code (built from src/i18n on the server). */
export type ReasonV4Templates = { useful: Partial<Record<UsefulReasonCode, string>>; growth: Partial<Record<GrowthReasonCode, string>> };

/** Resolves a reason param to a human label; unknown ids come back as-is. */
export type ReasonV4LabelOf = (
  kind: 'need' | 'offer' | 'interest' | 'function' | 'industry' | 'goal',
  id: string,
) => string;

/**
 * Facts a reason builder needs, all of them already normalized by the scorer.
 * Ids only — the builders never look at a raw profile.
 */
export interface ReasonV4Facts {
  /** Viewer goals advanced by this candidate, in the viewer's priority order. */
  goalsAdvanced: readonly string[];
  /** Viewer needs this candidate covers, in the viewer's priority order. */
  needsCovered: readonly string[];
  /** Candidate needs the viewer covers. */
  mutualNeeds: readonly string[];
  sharedInterests: readonly string[];
  /** [viewerFunction, candidateFunction] when the pair is complementary. */
  complementaryFunctions: readonly [string, string] | null;
  sameFunction: string | null;
  sameIndustry: string | null;
  /** Candidate offers that match a learning interest of the viewer. */
  teachableOffers: readonly string[];
  /** Candidate needs the viewer can serve. */
  helpableNeeds: readonly string[];
  /** True when the candidate is outside the viewer's function/industry. */
  outsideCircle: boolean;
  /** Different industry/function that still shares a topic, with the id. */
  differentContext: { kind: 'industry' | 'function'; id: string } | null;
}

/** Max sentences per line — a reason list is decoration, not a report. */
const MAX_PER_LINE = 3;

/** Line 1: why this person is USEFUL to the viewer. Deterministic order. */
export function buildUsefulReasons(facts: ReasonV4Facts): ReasonV4[] {
  const reasons: ReasonV4[] = [];
  for (const goal of facts.goalsAdvanced) {
    if (reasons.length >= MAX_PER_LINE) break;
    reasons.push({ code: 'goal_advanced', params: { goal } });
  }
  for (const need of facts.needsCovered) {
    if (reasons.length >= MAX_PER_LINE) break;
    reasons.push({ code: 'need_covered', params: { need } });
  }
  for (const need of facts.mutualNeeds) {
    if (reasons.length >= MAX_PER_LINE) break;
    reasons.push({ code: 'mutual_needs', params: { need } });
  }
  if (reasons.length < MAX_PER_LINE && facts.sharedInterests.length > 0) {
    reasons.push({ code: 'shared_interests', params: { interests: [...facts.sharedInterests] } });
  }
  if (reasons.length < MAX_PER_LINE && facts.complementaryFunctions) {
    const [mine, theirs] = facts.complementaryFunctions;
    reasons.push({ code: 'complementary_functions', params: { mine, theirs } });
  }
  if (reasons.length < MAX_PER_LINE && facts.sameIndustry) {
    reasons.push({ code: 'same_context', params: { industry: facts.sameIndustry } });
  } else if (reasons.length < MAX_PER_LINE && facts.sameFunction) {
    reasons.push({ code: 'same_context', params: { function: facts.sameFunction } });
  }
  return reasons;
}

/** Line 2: how this person DEVELOPS the viewer (learn from / give to). */
export function buildGrowthReasons(facts: ReasonV4Facts): ReasonV4[] {
  const reasons: ReasonV4[] = [];
  for (const offer of facts.teachableOffers) {
    if (reasons.length >= MAX_PER_LINE) break;
    reasons.push({ code: 'can_teach', params: { offer } });
  }
  for (const need of facts.helpableNeeds) {
    if (reasons.length >= MAX_PER_LINE) break;
    reasons.push({ code: 'wants_your_help', params: { need } });
  }
  if (reasons.length < MAX_PER_LINE && facts.differentContext) {
    reasons.push({
      code: 'different_context',
      params: { [facts.differentContext.kind]: facts.differentContext.id },
    });
  } else if (reasons.length < MAX_PER_LINE && facts.outsideCircle) {
    reasons.push({ code: 'outside_circle', params: {} });
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Rendering (same rules as src/domain/reasons.ts: total, blank-safe, pure)
// ---------------------------------------------------------------------------

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

/** Blank values collapse the sentence instead of rendering "Learn from: " . */
function fillOrBlank(template: string, vars: Record<string, string>): string {
  for (const value of Object.values(vars)) {
    if (value.trim().length === 0) return '';
  }
  return fill(template, vars);
}

function paramString(reason: ReasonV4, key: string): string | null {
  const value = reason.params[key];
  return typeof value === 'string' ? value : null;
}

/** Renders one reason. Unknown code / missing param falls back, never throws. */
export function formatReasonV4(
  reason: ReasonV4,
  templates: ReasonV4Templates,
  labelOf: ReasonV4LabelOf,
): string {
  const templatesForLine: Partial<Record<ReasonV4Code, string>> = isUsefulCode(reason.code)
    ? templates.useful
    : templates.growth;
  const template = templatesForLine[reason.code] ?? '';
  if (template.length === 0) return '';

  switch (reason.code) {
    case 'goal_advanced': {
      const goal = paramString(reason, 'goal');
      return fillOrBlank(template, { goal: goal ? labelOf('goal', goal) : '' });
    }
    case 'need_covered':
    case 'mutual_needs':
    case 'wants_your_help': {
      const need = paramString(reason, 'need');
      return fillOrBlank(template, { need: need ? labelOf('need', need) : '' });
    }
    case 'shared_interests': {
      const ids = reason.params['interests'];
      const list = Array.isArray(ids) ? ids : [];
      const names = list.map((id) => labelOf('interest', id)).join(', ');
      return fillOrBlank(template, { interests: names });
    }
    case 'complementary_functions': {
      const mine = paramString(reason, 'mine');
      const theirs = paramString(reason, 'theirs');
      return fillOrBlank(template, {
        mine: mine ? labelOf('function', mine) : '',
        theirs: theirs ? labelOf('function', theirs) : '',
      });
    }
    case 'same_context':
    case 'different_context': {
      const industry = paramString(reason, 'industry');
      const func = paramString(reason, 'function');
      if (industry) return fillOrBlank(template, { speciality: labelOf('industry', industry) });
      if (func) return fillOrBlank(template, { speciality: labelOf('function', func) });
      return '';
    }
    case 'can_teach': {
      const offer = paramString(reason, 'offer');
      return fillOrBlank(template, { offer: offer ? labelOf('need', offer) : '' });
    }
    case 'outside_circle':
    case 'peer_context':
      return template;
    default:
      return '';
  }
}

/**
 * Renders one LINE of the two-line explanation, dropping sentences that resolve
 * to nothing (a line with no sentence simply does not render, which is why the
 * design allows «Польза» and «Развитие» to appear independently).
 */
export function formatReasonLine(
  reasons: readonly ReasonV4[],
  templates: ReasonV4Templates,
  labelOf: ReasonV4LabelOf,
): string[] {
  return reasons
    .map((reason) => formatReasonV4(reason, templates, labelOf))
    .filter((sentence) => sentence.length > 0);
}

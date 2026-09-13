/**
 * Shared vocabulary for match reasons.
 *
 * The domain NEVER renders human text (TAXONOMY_V3.md: «Human reasons are always
 * answerable»). It emits a structural `Reason` — a code plus the catalogue ids the
 * sentence needs — and the UI renders it through i18n templates. That split is
 * what makes the three defects of the v1 strings impossible:
 *
 *   1. reasons_for_me and reasons_for_them can never be the same string, because
 *      the audience is part of the template key, not of the data;
 *   2. every sentence is localized (EN/RU/ES) in one place instead of being
 *      hardcoded in the domain with a ru/en switch;
 *   3. reason wording can change without touching (or re-testing) the score.
 *
 * Params are catalogue ids (`need`, `interests`, `function`, `industry`) or, for
 * the legacy tag path, the member's own raw tag text. Ids are resolved to labels
 * by the UI from the taxonomy catalogue — for `es` the catalogue has no labels,
 * so facet labels fall back to EN (documented deviation, see the pass-B report).
 */

export const REASON_CODES = [
  /** The viewer seeks X and the other side offers complement(X). */
  'intent_need_covered',
  /** The other side seeks Y and the viewer offers complement(Y). */
  'intent_offer_match',
  /** Overlap on the curated interest catalogue. params: interests[]. */
  'shared_interests',
  /** Same or complementary function. params: function. */
  'shared_function',
  /** Same industry. params: industry. */
  'same_industry',
  /** Legacy v1 tag overlap (frozen scorePair path). params: tag. */
  'shared_tag',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  readonly code: ReasonCode;
  readonly params: Readonly<Record<string, string | readonly string[]>>;
}

/** Whose reasons these are: `me` = reasons_for_me, `them` = reasons_for_them. */
export type ReasonAudience = 'me' | 'them';

/** i18n templates per audience, keyed by code (built from src/i18n on the server). */
export type ReasonTemplates = Record<ReasonAudience, Record<ReasonCode, string>>;

/**
 * Resolves a reason param to a human label. `kind` tells the caller which part of
 * the catalogue to look the id up in; unknown ids must be returned as-is so a
 * stale DB value degrades to the raw id instead of an empty sentence.
 */
export type ReasonLabelOf = (
  kind: 'need' | 'interest' | 'function' | 'industry',
  id: string,
) => string;

/** Local interpolation — a copy of the components/fill helper, kept pure here. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

function paramString(reason: Reason, key: string): string | null {
  const value = reason.params[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Renders one reason for one audience. Pure and total: an unknown code or a
 * missing param falls back to the template/param as-is rather than throwing,
 * because a reason is decoration on top of a score that is already computed.
 */
export function formatReason(
  reason: Reason,
  audience: ReasonAudience,
  templates: ReasonTemplates,
  labelOf: ReasonLabelOf,
): string {
  const template = templates[audience][reason.code] ?? '';
  switch (reason.code) {
    case 'intent_need_covered':
    case 'intent_offer_match': {
      const need = paramString(reason, 'need');
      return fill(template, { need: need ? labelOf('need', need) : '' });
    }
    case 'shared_interests': {
      const ids = reason.params['interests'];
      const list = Array.isArray(ids) ? ids : [];
      const names = list.map((id) => labelOf('interest', id)).join(', ');
      return fill(template, { interests: names });
    }
    case 'shared_function': {
      const id = paramString(reason, 'function');
      return fill(template, { function: id ? labelOf('function', id) : '' });
    }
    case 'same_industry': {
      const id = paramString(reason, 'industry');
      return fill(template, { industry: id ? labelOf('industry', id) : '' });
    }
    case 'shared_tag': {
      const tag = paramString(reason, 'tag');
      return fill(template, { tag: tag ?? '' });
    }
  }
}

/** Renders a whole list, dropping sentences that resolve to nothing. */
export function formatReasons(
  reasons: readonly Reason[],
  audience: ReasonAudience,
  templates: ReasonTemplates,
  labelOf: ReasonLabelOf,
): string[] {
  return reasons
    .map((reason) => formatReason(reason, audience, templates, labelOf))
    .filter((line) => line.length > 0 && !/^\{\w+\}$/.test(line));
}

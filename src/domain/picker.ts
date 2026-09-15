/**
 * Pure logic behind the taxonomy picker (src/components/taxonomy-picker.tsx).
 *
 * Kept out of the component on purpose: selection limits, catalogue search,
 * interest grouping, keyword normalization and reason-label resolution are the
 * rules the whole product depends on (3 need / 3 offer / 5 interest / 5 keyword,
 * 40 chars), and rules belong somewhere unit-testable without a DOM.
 *
 * The catalogue type mirrors GET /api/taxonomy (src/domain/taxonomy.ts
 * taxonomyPayload). UI locale may be `es` while the catalogue only carries
 * ru/en labels — the documented fallback is EN.
 */

import type { Reason, ReasonLabelOf } from './reasons';
import type { ReasonV4LabelOf } from './reasons-v4';
import { goalLabel } from './goals';

export type UiLocale = 'en' | 'ru' | 'es';

export interface CatalogLabels {
  ru: string;
  en: string;
}

export interface IntentSide {
  id: string;
  label: CatalogLabels;
  goal: CatalogLabels;
}

export interface TaxonomyCatalog {
  version: string;
  limits: {
    need_intents: number;
    offer_intents: number;
    interests: number;
    keywords: number;
    keyword_length: number;
  };
  intents: { id: string; need: IntentSide; offer: IntentSide }[];
  interests: { id: string; group: string; label: CatalogLabels }[];
  interest_groups: { id: string; label: CatalogLabels }[];
  functions: { id: string; label: CatalogLabels }[];
  industries: { id: string; label: CatalogLabels }[];
  prefer_not_to_say: string;
}

/** The three pickable axes. `function`/`industry` are single select, not chips. */
export type PickerAxis = 'need_intents' | 'offer_intents' | 'interests';

export interface ChipItem {
  id: string;
  label: string;
  /** Present for interests only. */
  group?: string;
}

export interface ChipGroup {
  id: string;
  label: string;
  items: ChipItem[];
}

/** Catalog label for a UI locale; `es` has no catalogue labels → EN. */
export function labelFor(labels: CatalogLabels | undefined, locale: UiLocale): string {
  if (!labels) return '';
  if (locale === 'ru') return labels.ru;
  return labels.en;
}

/**
 * Validates an unknown payload into a TaxonomyCatalog. Returns null when the
 * shape is unusable, so a broken/renamed endpoint degrades to "picker empty"
 * instead of rendering half-exploded chips.
 */
export function parseCatalog(raw: unknown): TaxonomyCatalog | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (c['version'] !== 'v3') return null;
  const limits = c['limits'];
  if (typeof limits !== 'object' || limits === null) return null;
  const l = limits as Record<string, unknown>;
  if (
    typeof l['need_intents'] !== 'number' ||
    typeof l['offer_intents'] !== 'number' ||
    typeof l['interests'] !== 'number' ||
    typeof l['keywords'] !== 'number' ||
    typeof l['keyword_length'] !== 'number'
  ) {
    return null;
  }
  if (!Array.isArray(c['intents']) || !Array.isArray(c['interests']) || !Array.isArray(c['functions']) || !Array.isArray(c['industries'])) {
    return null;
  }
  return {
    version: 'v3',
    limits: {
      need_intents: l['need_intents'],
      offer_intents: l['offer_intents'],
      interests: l['interests'],
      keywords: l['keywords'],
      keyword_length: l['keyword_length'],
    },
    intents: c['intents'] as TaxonomyCatalog['intents'],
    interests: c['interests'] as TaxonomyCatalog['interests'],
    interest_groups: Array.isArray(c['interest_groups']) ? (c['interest_groups'] as TaxonomyCatalog['interest_groups']) : [],
    functions: c['functions'] as TaxonomyCatalog['functions'],
    industries: c['industries'] as TaxonomyCatalog['industries'],
    prefer_not_to_say: typeof c['prefer_not_to_say'] === 'string' ? c['prefer_not_to_say'] : 'prefer-not-to-say',
  };
}

/** Limit for an axis, straight from the catalogue (no duplicated constants in the UI). */
export function limitFor(catalog: TaxonomyCatalog, axis: PickerAxis): number {
  return catalog.limits[axis];
}

/** Chip list for an axis, in catalogue order, labels resolved for the locale. */
export function itemsFor(catalog: TaxonomyCatalog, axis: PickerAxis, locale: UiLocale): ChipItem[] {
  if (axis === 'interests') {
    return catalog.interests.map((i) => ({ id: i.id, label: labelFor(i.label, locale), group: i.group }));
  }
  const kind = axis === 'need_intents' ? 'need' : 'offer';
  return catalog.intents.map((pair) => ({ id: pair[kind].id, label: labelFor(pair[kind].label, locale) }));
}

/** Case-insensitive match on the label and the id (ids are how power users search). */
export function filterChips(items: readonly ChipItem[], query: string): ChipItem[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...items];
  return items.filter((item) => item.label.toLowerCase().includes(q) || item.id.includes(q));
}

/**
 * Interests grouped by catalogue group, each group filtered and — when the user
 * is searching — groups that contain nothing are dropped.
 */
export function groupChips(
  catalog: TaxonomyCatalog,
  locale: UiLocale,
  query: string,
): ChipGroup[] {
  const groups = catalog.interest_groups.map((g) => ({
    id: g.id,
    label: labelFor(g.label, locale),
    items: filterChips(
      catalog.interests.filter((i) => i.group === g.id).map((i) => ({ id: i.id, label: labelFor(i.label, locale), group: i.group })),
      query,
    ),
  }));
  return groups.filter((g) => g.items.length > 0);
}

export type ToggleResult =
  | { ok: true; next: string[] }
  | { ok: false; reason: 'limit' };

/**
 * Adds/removes an id under a hard limit. Deselection is always allowed, so a
 * profile that already exceeds a shrunken limit can still be edited down.
 */
export function toggleSelection(current: readonly string[], id: string, limit: number): ToggleResult {
  if (current.includes(id)) {
    return { ok: true, next: current.filter((x) => x !== id) };
  }
  if (current.length >= limit) return { ok: false, reason: 'limit' };
  return { ok: true, next: [...current, id] };
}

export type KeywordResult =
  | { ok: true; next: string[] }
  | { ok: false; reason: 'limit' | 'too_long' };

/** Normalizes a keyword the same way the API does: trimmed, lowercased, deduped. */
export function addKeyword(
  current: readonly string[],
  raw: string,
  max: number,
  maxLength: number,
): KeywordResult {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return { ok: true, next: [...current] };
  if (value.length > maxLength) return { ok: false, reason: 'too_long' };
  if (current.includes(value)) return { ok: true, next: [...current] };
  if (current.length >= max) return { ok: false, reason: 'limit' };
  return { ok: true, next: [...current, value] };
}

/** Goal fragment of an intent id ("со-фаундера"), used by the reason templates. */
export function intentGoal(
  catalog: TaxonomyCatalog,
  kind: 'need' | 'offer',
  id: string,
  locale: UiLocale,
): string {
  for (const pair of catalog.intents) {
    const side = kind === 'need' ? pair.need : pair.offer;
    if (side.id === id) return labelFor(side.goal, locale);
  }
  // An intent id the current viewer offers but the catalogue moved: keep the id
  // rather than rendering an empty sentence.
  return id;
}

/** Resolves reason params to labels for formatReason(). Unknown ids pass through. */
export function reasonLabelOf(catalog: TaxonomyCatalog, locale: UiLocale): ReasonLabelOf {
  const interest = new Map(catalog.interests.map((i) => [i.id, labelFor(i.label, locale)]));
  const fn = new Map(catalog.functions.map((f) => [f.id, labelFor(f.label, locale)]));
  const industry = new Map(catalog.industries.map((i) => [i.id, labelFor(i.label, locale)]));
  return (kind, id) => {
    switch (kind) {
      case 'need':
        return intentGoal(catalog, 'need', id, locale);
      case 'interest':
        return interest.get(id) ?? id;
      case 'function':
        return fn.get(id) ?? id;
      case 'industry':
        return industry.get(id) ?? id;
    }
  };
}

/**
 * Resolves v4 reason params. Same contract as `reasonLabelOf`, plus the two
 * kinds v4 needs: `offer` intents (the candidate's strong side) and `goal` ids
 * (the catalogue of src/domain/goals.ts, whose labels already carry all three
 * locales). Unknown ids pass through, so a moved catalogue id degrades to the id
 * instead of an empty sentence.
 */
export function reasonLabelOfV4(catalog: TaxonomyCatalog, locale: UiLocale): ReasonV4LabelOf {
  const interest = new Map(catalog.interests.map((i) => [i.id, labelFor(i.label, locale)]));
  const fn = new Map(catalog.functions.map((f) => [f.id, labelFor(f.label, locale)]));
  const industry = new Map(catalog.industries.map((i) => [i.id, labelFor(i.label, locale)]));
  return (kind, id) => {
    switch (kind) {
      case 'need':
        return intentGoal(catalog, 'need', id, locale);
      case 'offer':
        return intentGoal(catalog, 'offer', id, locale);
      case 'interest':
        return interest.get(id) ?? id;
      case 'function':
        return fn.get(id) ?? id;
      case 'industry':
        return industry.get(id) ?? id;
      case 'goal':
        return goalLabel(id, locale) ?? id;
    }
  };
}

/** Human labels for a stored id list — used by the mini-landing and cards. */
export function labelsForIds(
  catalog: TaxonomyCatalog,
  axis: PickerAxis,
  ids: readonly string[],
  locale: UiLocale,
): string[] {
  return ids.map((id) => {
    if (axis === 'interests') {
      const hit = catalog.interests.find((i) => i.id === id);
      return hit ? labelFor(hit.label, locale) : id;
    }
    return intentGoal(catalog, axis === 'need_intents' ? 'need' : 'offer', id, locale);
  });
}

/** Reasons from the API, in one renderer-friendly shape. */
export type { Reason };

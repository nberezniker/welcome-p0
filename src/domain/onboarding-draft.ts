/**
 * Onboarding draft persistence (pure, storage-agnostic).
 *
 * The wizard keeps a versioned draft in localStorage so "3 questions" can be
 * interrupted: the user closes the tab on question 2 and finds question 2 back.
 * Only the strings the user typed or picked are stored — no enrichment output, no
 * sources (those are re-fetchable and would go stale), no derived values.
 *
 * Keeping (de)serialization here means the wizard component only touches
 * localStorage in two places and the shape is unit-tested.
 */

import type { LinkKind } from './links';

export const ONBOARDING_DRAFT_KEY = 'welcome.onboarding.draft.v1';
export const ONBOARDING_DRAFT_VERSION = 1;
export const ONBOARDING_STEPS = 4;

export interface OnboardingDraftValues {
  display_name: string;
  headline: string;
  company: string;
  short_bio: string;
  languages: string[];
  job_function: string | null;
  industry: string | null;
  need_intents: string[];
  offer_intents: string[];
  interests: string[];
  keywords: string[];
}

export interface OnboardingDraft {
  version: number;
  step: number;
  values: OnboardingDraftValues;
  /** Field id → typed link value (see LINK_KINDS). */
  links: Partial<Record<LinkKind, string>>;
  /** Public field ids the user unticked (deny list, mirrors profiles.hidden_fields). */
  hidden_fields: string[];
  saved_at: string;
}

export const EMPTY_DRAFT_VALUES: OnboardingDraftValues = {
  display_name: '',
  headline: '',
  company: '',
  short_bio: '',
  languages: [],
  job_function: null,
  industry: null,
  need_intents: [],
  offer_intents: [],
  interests: [],
  keywords: [],
};

const LINK_KIND_IDS: readonly LinkKind[] = ['linkedin_url', 'website', 'github_url', 'telegram_username', 'whatsapp'];

function asStringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.some((v) => typeof v !== 'string')) return null;
  return (value as string[]).slice(0, max);
}

function asOptionalString(value: unknown, max: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  return value.slice(0, max);
}

function asStep(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 1;
  return Math.min(Math.max(value, 1), ONBOARDING_STEPS);
}

/** Builds a draft with defaults; used on the first visit and after "start over". */
export function emptyDraft(): OnboardingDraft {
  return {
    version: ONBOARDING_DRAFT_VERSION,
    step: 1,
    values: { ...EMPTY_DRAFT_VALUES },
    links: {},
    hidden_fields: [],
    saved_at: new Date(0).toISOString(),
  };
}

/** Accepts anything read back from storage; returns null when unusable. */
export function parseDraft(raw: unknown): OnboardingDraft | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const d = value as Record<string, unknown>;
  if (d['version'] !== ONBOARDING_DRAFT_VERSION) return null; // a future/older shape is discarded, never half-read

  const rawValues = d['values'];
  if (typeof rawValues !== 'object' || rawValues === null) return null;
  const v = rawValues as Record<string, unknown>;

  const display_name = asOptionalString(v['display_name'], 120);
  const headline = asOptionalString(v['headline'], 200);
  const company = asOptionalString(v['company'], 120);
  const short_bio = asOptionalString(v['short_bio'], 1000);
  const job_function = asOptionalString(v['job_function'], 40);
  const industry = asOptionalString(v['industry'], 40);
  const languages = asStringArray(v['languages'] ?? [], 10);
  const need_intents = asStringArray(v['need_intents'] ?? [], 3);
  const offer_intents = asStringArray(v['offer_intents'] ?? [], 3);
  const interests = asStringArray(v['interests'] ?? [], 5);
  const keywords = asStringArray(v['keywords'] ?? [], 5);
  if (
    display_name === undefined || headline === undefined || company === undefined || short_bio === undefined ||
    job_function === undefined || industry === undefined ||
    languages === null || need_intents === null || offer_intents === null || interests === null || keywords === null
  ) {
    return null;
  }

  const links: Partial<Record<LinkKind, string>> = {};
  const rawLinks = d['links'];
  if (typeof rawLinks === 'object' && rawLinks !== null) {
    for (const kind of LINK_KIND_IDS) {
      const link = (rawLinks as Record<string, unknown>)[kind];
      if (typeof link === 'string' && link.length <= 300) links[kind] = link;
    }
  }

  const hidden = asStringArray(d['hidden_fields'] ?? [], 20) ?? [];

  return {
    version: ONBOARDING_DRAFT_VERSION,
    step: asStep(d['step']),
    values: {
      display_name: display_name ?? '',
      headline: headline ?? '',
      company: company ?? '',
      short_bio: short_bio ?? '',
      languages,
      job_function,
      industry,
      need_intents,
      offer_intents,
      interests,
      keywords,
    },
    links,
    hidden_fields: hidden,
    saved_at: typeof d['saved_at'] === 'string' ? d['saved_at'] : new Date(0).toISOString(),
  };
}

/** Stamps the draft and serializes it for localStorage. */
export function serializeDraft(draft: Omit<OnboardingDraft, 'saved_at' | 'version'>): string {
  return JSON.stringify({
    ...draft,
    version: ONBOARDING_DRAFT_VERSION,
    saved_at: new Date().toISOString(),
  });
}

/** Hidden-field ids derived from the publish checkboxes (unchecked = hidden). */
export function hiddenFromPublish(publish: Record<string, boolean>): string[] {
  return Object.entries(publish)
    .filter(([, published]) => !published)
    .map(([field]) => field);
}

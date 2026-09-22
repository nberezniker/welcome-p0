/**
 * Event-directory filter state ↔ URL contract.
 *
 * Kept pure so the contract (?mode=&interest=&function=&industry=&q=) is
 * unit-tested independently of React: the server page parses it, the client panel
 * writes it, and the directory API reads the same names (`function` is the UI
 * alias of the API's canonical `job_function`).
 */

export type DirectoryMode = 'intent' | 'interest' | 'all';

export const DIRECTORY_MODES: readonly DirectoryMode[] = ['intent', 'interest', 'all'];

/** Default mode: "they seek what I offer" (TAXONOMY_V3.md §Search/UX). */
export const DEFAULT_DIRECTORY_MODE: DirectoryMode = 'intent';

/**
 * The default mode for a viewer, given whether `intent` can produce ANYTHING.
 *
 * `intent` is the product's differentiated view — the point of the offer/need
 * axes is that "who is looking for what I offer" is answerable — so it stays the
 * default for everyone it can work for, and a particular event having no match
 * today is not a reason to replace it.
 *
 * The one case where it is not the default is the one where its emptiness is
 * ARITHMETIC rather than a finding: the API builds the intent filter from
 * `complementOf(viewer.offer_intents)`
 * (src/app/api/events/[eventIdOrSlug]/directory/route.ts — "Nothing to look for →
 * honest empty result, not a full directory dump"), so a viewer who offers
 * nothing at all gets an empty list BY CONSTRUCTION, whatever the event holds.
 * Opening on that screen, with the real list one tab away, reads as "this event
 * is empty" when it is not. Only that case falls back to `all`.
 *
 * The caller answers `intentPossible`, because it depends on the viewer's stored
 * taxonomy values — a database fact. Keeping it out of this module also keeps
 * the taxonomy catalogue out of the client bundle this file is imported by.
 */
export function defaultModeFor(intentPossible: boolean): DirectoryMode {
  return intentPossible ? DEFAULT_DIRECTORY_MODE : 'all';
}

export interface DirectoryFilters {
  mode: DirectoryMode;
  interest: string | null;
  jobFunction: string | null;
  industry: string | null;
  q: string;
}

export const EMPTY_DIRECTORY_FILTERS: DirectoryFilters = {
  mode: DEFAULT_DIRECTORY_MODE,
  interest: null,
  jobFunction: null,
  industry: null,
  q: '',
};

/** Serializes filter state into the URL. Empty values are omitted, not written blank. */
export function filtersToQuery(filters: DirectoryFilters): string {
  const params = new URLSearchParams();
  // Written unconditionally (including "all"): a shared link must reopen the same
  // mode, and the UI default (intent) differs from the API default (all).
  params.set('mode', filters.mode);
  if (filters.interest) params.set('interest', filters.interest);
  if (filters.jobFunction) params.set('function', filters.jobFunction);
  if (filters.industry) params.set('industry', filters.industry);
  const q = filters.q.trim();
  if (q.length > 0) params.set('q', q);
  return params.toString();
}

/**
 * Parses searchParams into filter state; anything unknown falls back to
 * `fallbackMode` — the product default unless the caller has a reason for
 * another one (see `defaultModeFor`: a viewer whose offer axis is empty gets
 * `all`, and only the caller can know that).
 *
 * An EXPLICIT `?mode=` always wins, including `mode=intent` for a viewer the
 * fallback would have sent to `all`: the default is a convenience, not a lock,
 * and a link that names a mode must reopen in that mode.
 */
export function filtersFromQuery(
  search: {
    mode?: string;
    interest?: string;
    function?: string;
    industry?: string;
    q?: string;
  },
  fallbackMode: DirectoryMode = DEFAULT_DIRECTORY_MODE,
): DirectoryFilters {
  const mode: DirectoryMode = (DIRECTORY_MODES as readonly string[]).includes(search.mode ?? '')
    ? (search.mode as DirectoryMode)
    : fallbackMode;
  return {
    mode,
    interest: search.interest ?? null,
    jobFunction: search.function ?? null,
    industry: search.industry ?? null,
    q: search.q ?? '',
  };
}

/** Query string for the directory API (canonical param names: `job_function` wins). */
export function filtersToApiQuery(filters: DirectoryFilters): string {
  const params = new URLSearchParams();
  params.set('mode', filters.mode);
  if (filters.interest) params.set('interest', filters.interest);
  if (filters.jobFunction) params.set('job_function', filters.jobFunction);
  if (filters.industry) params.set('industry', filters.industry);
  const q = filters.q.trim();
  if (q.length > 0) params.set('q', q);
  return params.toString();
}

/** True when the viewer narrowed anything (drives the "reset filters" affordance). */
export function hasActiveFilters(filters: DirectoryFilters): boolean {
  return Boolean(filters.interest || filters.jobFunction || filters.industry || filters.q.trim().length > 0);
}

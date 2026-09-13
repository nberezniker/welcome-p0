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

/** Parses searchParams into filter state; anything unknown falls back to the default. */
export function filtersFromQuery(search: {
  mode?: string;
  interest?: string;
  function?: string;
  industry?: string;
  q?: string;
}): DirectoryFilters {
  const mode: DirectoryMode = (DIRECTORY_MODES as readonly string[]).includes(search.mode ?? '')
    ? (search.mode as DirectoryMode)
    : DEFAULT_DIRECTORY_MODE;
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

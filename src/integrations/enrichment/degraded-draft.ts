import type { EnrichmentDraft } from './transport';

/**
 * Deterministic fallback draft, built from the requester's OWN profile fields.
 *
 * Why this exists (2026-09-14 usage-matrix, BUG-3): the grounded provider can
 * come back with no usable draft even after its internal retry — either because
 * the person has a thin public footprint or because the answer stayed empty.
 * Reporting 502 there left the UI with nothing at all on a perfectly healthy
 * profile, while the honest truth is "we found nothing new, here is what you
 * already told us".
 *
 * Properties:
 *   - deterministic: same input → same draft, no clocks, no randomness, no I/O;
 *   - non-inventive: every value is a field the user themself supplied (or is
 *     composed only from them) — no employers, titles or links are guessed;
 *   - suggestion-free: `suggested_interests` / `suggested_intents` stay empty
 *     (catalogue ids are never inferred) and `links` stays empty, because this
 *     draft claims nothing was found — the caller marks the whole response
 *     `degraded: true`.
 * The route returns it as HTTP 200 so the "fill in from the web" panel always
 * renders confirmable rows; the `degraded` flag keeps the difference honest.
 */
export interface DegradedDraftInput {
  displayName: string;
  company: string | null;
  /** Already-resolved human label of the own job function (null when unset). */
  jobFunction: string | null;
  /** Already-resolved human label of the own industry (null when unset). */
  industry: string | null;
}

/** Trims a profile value; whitespace-only counts as unset. */
function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function degradedEnrichmentDraft(input: DegradedDraftInput): EnrichmentDraft {
  const name = input.displayName.trim();
  const company = clean(input.company);
  const role = clean(input.jobFunction);
  const industry = clean(input.industry);

  // A headline is a short professional line: role · company, else the industry,
  // else — a profile with nothing but a name — the name itself. Never a guess.
  const headline = [role, company].filter((part): part is string => part !== null).join(' · ')
    || industry
    || name;

  const parts: string[] = [];
  if (role && company) parts.push(`${role} at ${company}`);
  else if (role) parts.push(role);
  else if (company) parts.push(company);
  if (industry) parts.push(industry);
  const shortBio = parts.length > 0 ? `${name} — ${parts.join(' · ')}.` : null;

  return {
    headline,
    short_bio: shortBio,
    company,
    links: [],
    suggested_interests: [],
    suggested_intents: [],
  };
}

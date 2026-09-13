'use client';

import { useState } from 'react';
import { fill } from './fill';
import { linkHref } from '../domain/links';
import { ENRICHMENT_RATE_LIMIT_PER_HOUR } from '../domain/enrichment-limits';

/** Enrichment draft as returned by POST /api/me/enrich (draft-only, never saved). */
export interface EnrichDraft {
  headline: string | null;
  short_bio: string | null;
  company: string | null;
  links: string[];
  suggested_interests: string[];
  suggested_intents: string[];
}

export interface EnrichSource {
  title: string;
  uri: string;
}

/** One draft row: which field, what it is called, what the draft says. */
export interface EnrichRow {
  key: string;
  label: string;
  value: string;
}

export type EnrichStrings = {
  cta: string;
  busy: string;
  hint: string;
  sources: string;
  suggested: string;
  apply: string;
  applied: string;
  noDraft: string;
  rateLimited: string;
  disabled: string;
  failed: string;
  retry: string;
  privacyNote: string;
  errorNetwork: string;
};

type EnrichState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ready'; draft: EnrichDraft; sources: EnrichSource[] }
  | { kind: 'error'; reason: 'rate_limited' | 'disabled' | 'failed' | 'network' };

/**
 * "Fill in from the web" (ONBOARDING_MINI_LANDING.md §auto-fill, user-confirms).
 *
 * The panel owns only the transient part: the request, the provider errors and
 * the draft+source rendering. It NEVER writes to the form — every row has its own
 * Apply button that calls back into the parent, which is what makes "nothing is
 * published without confirmation" a structural property instead of a promise.
 *
 * Used by the onboarding confirm step and by /me/profile (same quota, same
 * 429/503 vocabulary).
 */
export function EnrichPanel({
  strings,
  buildRows,
  onApply,
  testId = 'enrich',
}: {
  strings: EnrichStrings;
  /** Turns a draft into the rows to render (the parent owns the catalogue labels). */
  buildRows: (draft: EnrichDraft) => EnrichRow[];
  /** Called for one row when the user presses Apply. Never called automatically. */
  onApply: (row: EnrichRow, draft: EnrichDraft) => void;
  testId?: string;
}) {
  const [state, setState] = useState<EnrichState>({ kind: 'idle' });
  const [applied, setApplied] = useState<Record<string, boolean>>({});

  const run = async () => {
    setState({ kind: 'busy' });
    try {
      const res = await fetch('/api/me/enrich', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => null)) as
        | { draft?: EnrichDraft; sources?: EnrichSource[] }
        | null;
      if (res.ok && body?.draft) {
        setState({ kind: 'ready', draft: body.draft, sources: body.sources ?? [] });
        setApplied({});
        return;
      }
      if (res.status === 429) setState({ kind: 'error', reason: 'rate_limited' });
      else if (res.status === 503) setState({ kind: 'error', reason: 'disabled' });
      else setState({ kind: 'error', reason: 'failed' });
    } catch {
      setState({ kind: 'error', reason: 'network' });
    }
  };

  const errorMessage = (error: EnrichState): string | null => {
    if (error.kind !== 'error') return null;
    switch (error.reason) {
      case 'rate_limited':
        return fill(strings.rateLimited, { max: ENRICHMENT_RATE_LIMIT_PER_HOUR });
      case 'disabled':
        return strings.disabled;
      case 'network':
        return strings.errorNetwork;
      default:
        return strings.failed;
    }
  };

  const rows = state.kind === 'ready' ? buildRows(state.draft).filter((row) => row.value.length > 0) : [];
  const message = errorMessage(state);

  return (
    <div className="rounded-xl border border-line bg-paper p-4" data-testid={testId}>
      <button
        type="button"
        className="btn-primary btn-small"
        disabled={state.kind === 'busy'}
        onClick={() => void run()}
        data-testid={`${testId}-run`}
      >
        {state.kind === 'busy' ? strings.busy : strings.cta}
      </button>
      <p className="mt-2 text-xs leading-relaxed text-muted">{strings.hint}</p>
      <p className="mt-1 text-xs font-semibold text-pine">{strings.privacyNote}</p>

      {message ? (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="alert">
          <p className="text-sm text-red-700">{message}</p>
          <button
            type="button"
            className="btn-light btn-small"
            onClick={() => void run()}
            data-testid={`${testId}-retry`}
          >
            {strings.retry}
          </button>
        </div>
      ) : null}

      {state.kind === 'ready' ? (
        <div className="mt-3" data-testid={`${testId}-draft`}>
          {rows.length === 0 ? (
            <p className="text-sm text-muted" data-testid={`${testId}-empty`}>
              {strings.noDraft}
            </p>
          ) : (
            <>
              <p className="text-sm font-bold">{strings.suggested}</p>
              <ul className="mt-2 flex flex-col gap-2">
                {rows.map((row) => (
                  <li
                    key={row.key}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line bg-white px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-[11px] font-bold uppercase tracking-wide text-muted">{row.label}</p>
                      <p className="break-words text-sm">{row.value}</p>
                    </div>
                    <button
                      type="button"
                      className="btn-light btn-small"
                      onClick={() => {
                        onApply(row, state.draft);
                        setApplied((prev) => ({ ...prev, [row.key]: true }));
                      }}
                      data-testid={`${testId}-apply-${row.key}`}
                    >
                      {applied[row.key] ? strings.applied : strings.apply}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {state.sources.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-bold uppercase tracking-wide text-muted">{strings.sources}</p>
              <ul className="mt-1 flex flex-col gap-1">
                {state.sources.map((source) => {
                  const href = linkHref('website', source.uri);
                  return (
                    <li key={source.uri} className="text-xs">
                      {href ? (
                        <a
                          className="break-all font-medium underline underline-offset-2"
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                        >
                          {source.title}
                        </a>
                      ) : (
                        <span className="break-all">{source.title}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, Toast, useToast } from '../../../../../components/modal';
import { fill } from '../../../../../components/fill';
import { ReasonList } from '../../../../../components/reason-list';
import { useTaxonomyCatalog } from '../../../../../components/taxonomy-catalog';
import type { Reason, ReasonTemplates } from '../../../../../domain/reasons';
import {
  filtersToApiQuery,
  filtersToQuery,
  hasActiveFilters,
  type DirectoryFilters,
  type DirectoryMode,
} from '../../../../../domain/directory-filters';
import { labelFor, type TaxonomyCatalog, type UiLocale } from '../../../../../domain/picker';
// Contact kinds (what an introduction can reveal) — not link kinds: phone is
// revealable but is not a card link.
import type { ContactKind } from '../../../../../domain/profile';

export interface DirectoryMember {
  profile_id: string;
  display_name: string;
  headline: string | null;
  company: string | null;
  offer_tags: string[];
  need_tags: string[];
  need_intents: string[];
  offer_intents: string[];
  interests: string[];
  industry: string | null;
  job_function: string | null;
}

export interface RecommendationItem extends DirectoryMember {
  score: number;
  /** Structural reasons — rendered by ReasonList, never shown raw. */
  reasons_for_me: Reason[];
  reasons_for_them: Reason[];
}

type Strings = {
  loading: string;
  empty: string;
  closed: string;
  membersTitle: string;
  proposeIntro: string;
  proposed: string;
  introSentToast: string;
  introAlready: string;
  revealChooserTitleTemplate: string;
  revealChooserHint: string;
  sendRequest: string;
  sending: string;
  recommendationsTitle: string;
  recommendationsEmpty: string;
  scoreTemplate: string;
  notVisibleNote: string;
  cancel: string;
  errorNetwork: string;
  errorGeneric: string;
  modes: Record<DirectoryMode, string>;
  modeHints: Record<DirectoryMode, string>;
  filterInterest: string;
  filterFunction: string;
  filterIndustry: string;
  searchLabel: string;
  searchPlaceholder: string;
  clearFilters: string;
  resultCount: string;
  looksFor: string;
  canOffer: string;
  unspecified: string;
};

const ALL_KINDS: readonly ContactKind[] = [
  'whatsapp',
  'telegram_username',
  'linkedin_url',
  'website',
  'phone',
  'github_url',
];

const MODES: readonly DirectoryMode[] = ['intent', 'interest', 'all'];

// The URL/API query contract lives in src/domain/directory-filters.ts
// (pure, unit-tested) — this component only renders and applies it.

/**
 * Event directory: three modes (intent / interest / all) with facet filters and a
 * free-text search, plus the recommendations strip. All filter state lives in the
 * URL so a narrowed view can be shared or bookmarked, and the directory API stays
 * the only data source — no client-side filtering of a truncated list.
 */
export function DirectoryPanel({
  eventId,
  initialFilters,
  kindLabels,
  locale,
  reasonTemplates,
  strings,
}: {
  eventId: string;
  initialFilters: DirectoryFilters;
  kindLabels: Record<ContactKind, string>;
  locale: UiLocale;
  reasonTemplates: ReasonTemplates;
  strings: Strings;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<DirectoryFilters>(initialFilters);
  const [members, setMembers] = useState<DirectoryMember[] | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationItem[] | null>(null);
  const [closed, setClosed] = useState(false);
  const [chooserMember, setChooserMember] = useState<DirectoryMember | null>(null);
  const [revealKinds, setRevealKinds] = useState<ContactKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());
  const toast = useToast();
  const { catalog } = useTaxonomyCatalog();
  const { mode, interest, jobFunction, industry, q } = filters;

  /** Applies new filters; the URL mirror below keeps the link shareable. */
  const apply = useCallback((patch: Partial<DirectoryFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  // URL mirroring is an effect, not a side effect inside the state updater:
  // updaters must stay pure, and the refetch below reacts to the same state.
  useEffect(() => {
    const query = filtersToQuery(filters);
    router.replace(`/me/events/${eventId}/directory${query ? `?${query}` : ''}`, { scroll: false });
  }, [filters, eventId, router]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const apiQuery = filtersToApiQuery({ mode, interest, jobFunction, industry, q });
      try {
        const [dirRes, recRes] = await Promise.all([
          fetch(`/api/events/${eventId}/directory?${apiQuery}`),
          fetch(`/api/events/${eventId}/recommendations`),
        ]);
        if (cancelled) return;
        if (dirRes.status === 403) {
          const body = (await dirRes.json().catch(() => null)) as { code?: string } | null;
          if (body?.code === 'directory_closed') setClosed(true);
          setMembers([]);
        } else if (dirRes.ok) {
          const body = (await dirRes.json().catch(() => null)) as { members?: DirectoryMember[] } | null;
          setMembers(body?.members ?? []);
        } else {
          setMembers([]);
        }
        if (recRes.ok) {
          const body = (await recRes.json().catch(() => null)) as { recommendations?: RecommendationItem[] } | null;
          setRecommendations(body?.recommendations ?? []);
        } else {
          setRecommendations([]);
        }
      } catch {
        if (!cancelled) {
          setMembers([]);
          setRecommendations([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, mode, interest, jobFunction, industry, q]);

  const propose = async () => {
    if (!chooserMember) return;
    setBusy(true);
    try {
      const res = await fetch('/api/introductions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target_profile_id: chooserMember.profile_id,
          event_id: eventId,
          reveal_fields: revealKinds,
        }),
      });
      const body = (await res.json().catch(() => null)) as { already_existed?: boolean } | null;
      if (res.ok) {
        setSentTo((prev) => new Set(prev).add(chooserMember.profile_id));
        toast.show(body?.already_existed ? strings.introAlready : strings.introSentToast);
        setChooserMember(null);
        setRevealKinds([]);
      } else {
        toast.show(strings.errorGeneric, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (closed) return <p className="text-sm text-muted">{strings.closed}</p>;

  const hasFilters = hasActiveFilters({ mode, interest, jobFunction, industry, q });

  return (
    <div className="flex flex-col gap-8">
      {/* Recommendations strip */}
      <section aria-labelledby="recs-heading">
        <h2 id="recs-heading" className="text-lg font-bold tracking-tight">
          {strings.recommendationsTitle}
        </h2>
        {recommendations === null ? (
          <p className="mt-2 text-sm text-muted">{strings.loading}</p>
        ) : recommendations.length === 0 ? (
          <p className="mt-2 text-sm text-muted" data-testid="recommendations-empty">
            {strings.recommendationsEmpty}
          </p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {recommendations.map((rec) => (
              <article key={rec.profile_id} className="card-tight" data-testid={`rec-${rec.profile_id}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-bold">{rec.display_name}</h3>
                  <span className="chip">{fill(strings.scoreTemplate, { score: rec.score })}</span>
                </div>
                <p className="text-xs text-muted">{rec.headline ?? rec.company ?? ''}</p>
                {/* Two audiences, two templates: "what this means for me" vs
                    "what I mean to them" can never render the same sentence. */}
                <ReasonList
                  reasons={rec.reasons_for_me}
                  audience="me"
                  templates={reasonTemplates}
                  catalog={catalog}
                  locale={locale}
                  className="mt-2 flex flex-col gap-0.5 text-xs text-pine"
                  testId={`reasons-me-${rec.profile_id}`}
                />
                <ReasonList
                  reasons={rec.reasons_for_them}
                  audience="them"
                  templates={reasonTemplates}
                  catalog={catalog}
                  locale={locale}
                  className="mt-1 flex flex-col gap-0.5 text-xs text-muted"
                  testId={`reasons-them-${rec.profile_id}`}
                />
                <button
                  type="button"
                  className="btn-light btn-small mt-3 w-full"
                  disabled={busy || sentTo.has(rec.profile_id)}
                  onClick={() => {
                    setChooserMember(rec);
                    setRevealKinds([]);
                  }}
                >
                  {sentTo.has(rec.profile_id) ? strings.proposed : strings.proposeIntro}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Modes + filters + member list */}
      <section aria-labelledby="dir-heading">
        <h2 id="dir-heading" className="text-lg font-bold tracking-tight">
          {strings.membersTitle}
        </h2>

        <div role="tablist" aria-label={strings.membersTitle} className="mt-3 flex flex-wrap gap-2">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? 'btn-primary btn-small' : 'btn-light btn-small'}
              onClick={() => apply({ mode: m })}
              data-testid={`dir-mode-${m}`}
            >
              {strings.modes[m]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted" data-testid="dir-mode-hint">
          {strings.modeHints[mode]}
        </p>

        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-line bg-white p-3">
          <div>
            <label className="label" htmlFor="dir-q">
              {strings.searchLabel}
            </label>
            <input
              id="dir-q"
              className="input"
              type="search"
              value={q}
              placeholder={strings.searchPlaceholder}
              onChange={(e) => setFilters((prev) => ({ ...prev, q: e.target.value }))}
              onBlur={(e) => apply({ q: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') apply({ q: (e.target as HTMLInputElement).value });
              }}
              data-testid="dir-search"
            />
          </div>

          {catalog ? (
            <div className="flex flex-wrap gap-2">
              <label className="sr-only" htmlFor="dir-interest">
                {strings.filterInterest}
              </label>
              <select
                id="dir-interest"
                className="input max-w-xs"
                value={interest ?? ''}
                onChange={(e) => apply({ interest: e.target.value === '' ? null : e.target.value })}
                data-testid="dir-filter-interest"
              >
                <option value="">{`${strings.filterInterest}: ${strings.unspecified}`}</option>
                {catalog.interests.map((item) => (
                  <option key={item.id} value={item.id}>
                    {labelFor(item.label, locale)}
                  </option>
                ))}
              </select>

              <label className="sr-only" htmlFor="dir-function">
                {strings.filterFunction}
              </label>
              <select
                id="dir-function"
                className="input max-w-xs"
                value={jobFunction ?? ''}
                onChange={(e) => apply({ jobFunction: e.target.value === '' ? null : e.target.value })}
                data-testid="dir-filter-function"
              >
                <option value="">{`${strings.filterFunction}: ${strings.unspecified}`}</option>
                {catalog.functions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {labelFor(item.label, locale)}
                  </option>
                ))}
              </select>

              <label className="sr-only" htmlFor="dir-industry">
                {strings.filterIndustry}
              </label>
              <select
                id="dir-industry"
                className="input max-w-xs"
                value={industry ?? ''}
                onChange={(e) => apply({ industry: e.target.value === '' ? null : e.target.value })}
                data-testid="dir-filter-industry"
              >
                <option value="">{`${strings.filterIndustry}: ${strings.unspecified}`}</option>
                {catalog.industries.map((item) => (
                  <option key={item.id} value={item.id}>
                    {labelFor(item.label, locale)}
                  </option>
                ))}
              </select>

              {hasFilters ? (
                <button
                  type="button"
                  className="btn-light btn-small"
                  onClick={() => apply({ interest: null, jobFunction: null, industry: null, q: '' })}
                  data-testid="dir-clear-filters"
                >
                  {strings.clearFilters}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {members === null ? (
          <p className="mt-3 text-sm text-muted">{strings.loading}</p>
        ) : (
          <>
            <p className="mt-3 text-xs text-muted" data-testid="dir-result-count">
              {fill(strings.resultCount, { n: members.length })}
            </p>
            {members.length === 0 ? (
              <p className="mt-2 text-sm text-muted" data-testid="directory-empty">
                {/* An empty intent/interest result means "nobody matches the
                    viewer's own axes", not "the event is empty" — say which. */}
                {mode === 'all' ? strings.empty : strings.modeHints[mode]}
              </p>
            ) : (
              <ul className="mt-3 grid gap-3 md:grid-cols-2" data-testid="member-list">
                {members.map((m) => (
                  <li key={m.profile_id} className="card-tight" data-testid={`member-${m.profile_id}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="text-sm font-bold">{m.display_name}</h3>
                      <span className="text-xs text-muted">{m.company ?? ''}</span>
                    </div>
                    {m.headline ? <p className="text-xs text-muted">{m.headline}</p> : null}
                    <div className="mt-2 flex flex-col gap-1">
                      <MemberAxes
                        label={strings.canOffer}
                        ids={m.offer_intents}
                        legacy={m.offer_tags}
                        axis="offer_intents"
                        catalog={catalog}
                        locale={locale}
                        className="chip-offer"
                      />
                      <MemberAxes
                        label={strings.looksFor}
                        ids={m.need_intents}
                        legacy={m.need_tags}
                        axis="need_intents"
                        catalog={catalog}
                        locale={locale}
                        className="chip-need"
                      />
                      <MemberAxes
                        label={strings.filterInterest}
                        ids={m.interests}
                        legacy={[]}
                        axis="interests"
                        catalog={catalog}
                        locale={locale}
                        className="chip"
                      />
                    </div>
                    <button
                      type="button"
                      className="btn-primary btn-small mt-3"
                      disabled={busy || sentTo.has(m.profile_id)}
                      onClick={() => {
                        setChooserMember(m);
                        setRevealKinds([]);
                      }}
                      data-testid={`propose-${m.profile_id}`}
                    >
                      {sentTo.has(m.profile_id) ? strings.proposed : strings.proposeIntro}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* Reveal-fields chooser */}
      <Modal
        open={chooserMember !== null}
        onClose={() => setChooserMember(null)}
        title={chooserMember ? fill(strings.revealChooserTitleTemplate, { name: chooserMember.display_name }) : ''}
      >
        <p className="text-xs text-muted">{strings.revealChooserHint}</p>
        <fieldset className="mt-3">
          <legend className="sr-only">{strings.revealChooserHint}</legend>
          <div className="flex flex-wrap gap-3">
            {ALL_KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={revealKinds.includes(kind)}
                  onChange={(e) =>
                    setRevealKinds((prev) => (e.target.checked ? [...prev, kind] : prev.filter((k) => k !== kind)))
                  }
                />
                {kindLabels[kind]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-light btn-small" onClick={() => setChooserMember(null)}>
            {strings.cancel}
          </button>
          <button
            type="button"
            className="btn-accent btn-small"
            disabled={busy}
            onClick={() => void propose()}
            data-testid="send-intro"
          >
            {busy ? strings.sending : strings.sendRequest}
          </button>
        </div>
      </Modal>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </div>
  );
}

/** One axis row on a member card: catalogue labels, with legacy tags as fallback. */
function MemberAxes({
  label,
  ids,
  legacy,
  axis,
  catalog,
  locale,
  className,
}: {
  label: string;
  ids: string[];
  legacy: string[];
  axis: 'need_intents' | 'offer_intents' | 'interests';
  catalog: TaxonomyCatalog | null;
  locale: UiLocale;
  className: string;
}) {
  const labels = memberLabels(catalog, axis, ids, legacy, locale);
  if (labels.length === 0) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-1.5">
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</span>
      {labels.map((item, index) => (
        <span key={`${item}-${index}`} className={className}>
          {item}
        </span>
      ))}
    </p>
  );
}

/** Catalogue label for a stored id; raw id for stale values; tags when no v3 data. */
function memberLabels(
  catalog: TaxonomyCatalog | null,
  axis: 'need_intents' | 'offer_intents' | 'interests',
  ids: string[],
  legacy: string[],
  locale: UiLocale,
): string[] {
  if (ids.length === 0) return legacy;
  if (!catalog) return ids;
  if (axis === 'interests') {
    return ids.map((id) => {
      const hit = catalog.interests.find((i) => i.id === id);
      return hit ? labelFor(hit.label, locale) : id;
    });
  }
  const kind = axis === 'need_intents' ? 'need' : 'offer';
  return ids.map((id) => {
    for (const pair of catalog.intents) {
      const side = kind === 'need' ? pair.need : pair.offer;
      if (side.id === id) return labelFor(side.goal, locale);
    }
    return id;
  });
}

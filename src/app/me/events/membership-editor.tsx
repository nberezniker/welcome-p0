'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TagInput } from '../../../components/tag-input';
import { Toast, useToast } from '../../../components/modal';
import { FacetSelect, KeywordInput, TaxonomyPicker, type PickerStrings } from '../../../components/taxonomy-picker';
import type { TaxonomyCatalog, UiLocale } from '../../../domain/picker';

export interface MembershipItem {
  membershipId: string;
  eventId: string;
  eventSlug: string;
  eventName: string;
  eventMode: string;
  state: string;
  directoryVisible: boolean;
  matchingEnabled: boolean;
  offerTags: string[];
  needTags: string[];
  /** Per-event taxonomy overrides; empty/absent = inherit the profile value. */
  needIntents: string[];
  offerIntents: string[];
  interests: string[];
  industry: string | null;
  jobFunction: string | null;
  keywords: string[];
}

type Strings = {
  openEvent: string;
  openDirectory: string;
  leftBadge: string;
  leave: string;
  leaveConfirm: string;
  leftToast: string;
  intentTitle: string;
  offerTagsLabel: string;
  needTagsLabel: string;
  directoryVisible: string;
  directoryVisibleHint: string;
  matchingEnabled: string;
  matchingEnabledHint: string;
  savedToast: string;
  save: string;
  saving: string;
  tagPlaceholder: string;
  errorNetwork: string;
  errorGeneric: string;
  overrideTitle: string;
  overrideHint: string;
  inheritHint: string;
  overrideNeed: string;
  overrideOffer: string;
  overrideInterests: string;
  overrideFunction: string;
  overrideIndustry: string;
  overrideKeywords: string;
  picker: PickerStrings;
  pick: {
    needHint: string;
    offerHint: string;
    interestsHint: string;
    keywordsHint: string;
    functionHint: string;
    industryHint: string;
  };
};

export interface MembershipEditorProps {
  membership: MembershipItem;
  strings: Strings;
  catalog: TaxonomyCatalog;
  locale: UiLocale;
}

/** Per-event membership editor: taxonomy overrides, intent tags, visibility, matching, leave. */
export function MembershipEditor({ membership, strings, catalog, locale }: MembershipEditorProps) {
  const router = useRouter();
  const [offerTags, setOfferTags] = useState(membership.offerTags);
  const [needTags, setNeedTags] = useState(membership.needTags);
  const [needIntents, setNeedIntents] = useState<string[]>(membership.needIntents);
  const [offerIntents, setOfferIntents] = useState<string[]>(membership.offerIntents);
  const [interests, setInterests] = useState<string[]>(membership.interests);
  const [keywords, setKeywords] = useState<string[]>(membership.keywords);
  const [jobFunction, setJobFunction] = useState<string | null>(membership.jobFunction);
  const [industry, setIndustry] = useState<string | null>(membership.industry);
  const [directoryVisible, setDirectoryVisible] = useState(membership.directoryVisible);
  const [matchingEnabled, setMatchingEnabled] = useState(membership.matchingEnabled);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(membership.state !== 'active');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const toast = useToast();

  const patch = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/me/memberships/${membership.membershipId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        if (payload['state'] === 'left') {
          setLeft(true);
          toast.show(strings.leftToast);
        } else {
          toast.show(strings.savedToast);
        }
        router.refresh();
      } else {
        toast.show(strings.errorGeneric, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
      setConfirmLeave(false);
    }
  };

  return (
    <section className="card" data-testid={`membership-${membership.eventId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {/* h2, not h3: the page's own heading is the h1 ("My events"), so an h3
            here skips a level — an axe `heading-order` finding (moderate) on the
            only page this editor renders on. The tag changed, the classes did
            not, so nothing about the card's look moves. */}
        <h2 className="text-lg font-bold tracking-tight">{membership.eventName}</h2>
        <span className={left ? 'chip !bg-paper !text-muted' : 'chip'}>{left ? strings.leftBadge : '✓'}</span>
      </div>
      <p className="mt-1 text-xs uppercase tracking-wide text-muted">{membership.eventMode}</p>

      {!left ? (
        <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
          <p className="text-sm font-bold">{strings.intentTitle}</p>
          <TagInput
            id={`offer-${membership.membershipId}`}
            label={strings.offerTagsLabel}
            values={offerTags}
            onChange={setOfferTags}
            placeholder={strings.tagPlaceholder}
          />
          <TagInput
            id={`need-${membership.membershipId}`}
            label={strings.needTagsLabel}
            values={needTags}
            onChange={setNeedTags}
            placeholder={strings.tagPlaceholder}
          />
          {/* Taxonomy v3 overrides: empty means "inherit my profile" (the API
              treats an empty membership array as "fall back to the profile"). */}
          <div className="rounded-xl border border-line bg-paper p-3">
            <p className="text-sm font-bold">{strings.overrideTitle}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{strings.overrideHint}</p>
            <p className="mt-1 text-xs font-semibold text-pine">{strings.inheritHint}</p>
            <div className="mt-3 flex flex-col gap-5">
              <TaxonomyPicker
                axis="need_intents"
                catalog={catalog}
                locale={locale}
                value={needIntents}
                onChange={setNeedIntents}
                strings={strings.picker}
                title={strings.overrideNeed}
                hint={strings.pick.needHint.replace('{max}', String(catalog.limits.need_intents))}
                testId={`member-needs-${membership.eventId}`}
                compact
              />
              <TaxonomyPicker
                axis="offer_intents"
                catalog={catalog}
                locale={locale}
                value={offerIntents}
                onChange={setOfferIntents}
                strings={strings.picker}
                title={strings.overrideOffer}
                hint={strings.pick.offerHint.replace('{max}', String(catalog.limits.offer_intents))}
                testId={`member-offers-${membership.eventId}`}
                compact
              />
              <TaxonomyPicker
                axis="interests"
                catalog={catalog}
                locale={locale}
                value={interests}
                onChange={setInterests}
                strings={strings.picker}
                title={strings.overrideInterests}
                hint={strings.pick.interestsHint.replace('{max}', String(catalog.limits.interests))}
                testId={`member-interests-${membership.eventId}`}
                compact
              />
              <KeywordInput
                id={`member-keywords-${membership.membershipId}`}
                title={strings.overrideKeywords}
                hint={strings.pick.keywordsHint
                  .replace('{max}', String(catalog.limits.keywords))
                  .replace('{length}', String(catalog.limits.keyword_length))}
                values={keywords}
                onChange={setKeywords}
                strings={strings.picker}
                max={catalog.limits.keywords}
                maxLength={catalog.limits.keyword_length}
                testId={`member-keywords-${membership.eventId}`}
              />
              <FacetSelect
                id={`member-function-${membership.membershipId}`}
                title={strings.overrideFunction}
                hint={strings.pick.functionHint}
                catalog={catalog}
                locale={locale}
                kind="functions"
                value={jobFunction}
                onChange={setJobFunction}
                strings={strings.picker}
                testId={`member-function-${membership.eventId}`}
              />
              <FacetSelect
                id={`member-industry-${membership.membershipId}`}
                title={strings.overrideIndustry}
                hint={strings.pick.industryHint}
                catalog={catalog}
                locale={locale}
                kind="industries"
                value={industry}
                onChange={setIndustry}
                strings={strings.picker}
                testId={`member-industry-${membership.eventId}`}
              />
            </div>
          </div>

          <button
            type="button"
            className="btn-primary btn-small self-start"
            disabled={busy}
            onClick={() =>
              void patch({
                offer_tags: offerTags,
                need_tags: needTags,
                need_intents: needIntents,
                offer_intents: offerIntents,
                interests,
                keywords,
                job_function: jobFunction,
                industry,
              })
            }
            data-testid={`save-intent-${membership.eventId}`}
          >
            {busy ? strings.saving : strings.save}
          </button>

          {/* The ROW is the tap target — the same pattern as the event page's
              member panel. A bare `size-4` checkbox is a 16x16 box (13x16 as the
              UA paints it), and the measurement that reported it below the 44px
              floor was reading the input's own box rather than the clickable
              area. The <label> wraps the control and carries `min-h-11`, so a
              thumb anywhere on the row toggles it while the glyph keeps its size
              and look. `items-start` + `mt-0.5` (half the difference between the
              16px box and the 20px line box) keeps the checkbox on the FIRST
              line instead of centring it against the multi-line hint.

              The title and the hint are <span>s because a <label> may only
              contain phrasing content; `block` on the outer one reproduces the
              two-line stack, and under Tailwind's preflight a block <span>
              renders exactly like the <p> it replaced. The hint is inside the
              label, so it also contributes to the control's accessible name —
              which is why it stays a full sentence and `aria-describedby` is
              kept (the two agree rather than one paraphrasing the other). */}
          <label
            htmlFor={`dir-${membership.membershipId}`}
            className="flex min-h-11 cursor-pointer items-start gap-2"
          >
            <input
              id={`dir-${membership.membershipId}`}
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={directoryVisible}
              disabled={busy}
              onChange={(e) => {
                setDirectoryVisible(e.target.checked);
                void patch({ directory_visible: e.target.checked });
              }}
              aria-describedby={`dir-hint-${membership.membershipId}`}
              data-testid={`dir-toggle-${membership.eventId}`}
            />
            <span className="block">
              <span className="text-sm font-semibold">{strings.directoryVisible}</span>
              <span id={`dir-hint-${membership.membershipId}`} className="block text-xs leading-relaxed text-muted">
                {strings.directoryVisibleHint}
              </span>
            </span>
          </label>

          <label
            htmlFor={`match-${membership.membershipId}`}
            className="flex min-h-11 cursor-pointer items-start gap-2"
          >
            <input
              id={`match-${membership.membershipId}`}
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={matchingEnabled}
              disabled={busy}
              onChange={(e) => {
                setMatchingEnabled(e.target.checked);
                void patch({ matching_enabled: e.target.checked });
              }}
              aria-describedby={`match-hint-${membership.membershipId}`}
              data-testid={`matching-toggle-${membership.eventId}`}
            />
            <span className="block">
              <span className="text-sm font-semibold">{strings.matchingEnabled}</span>
              <span id={`match-hint-${membership.membershipId}`} className="block text-xs leading-relaxed text-muted">
                {strings.matchingEnabledHint}
              </span>
            </span>
          </label>

          <div className="flex flex-wrap gap-2 border-t border-line pt-3">
            <a href={`/e/${membership.eventSlug}`} className="btn-light btn-small">
              {strings.openEvent}
            </a>
            <a href={`/me/events/${membership.eventId}/directory`} className="btn-light btn-small">
              {strings.openDirectory}
            </a>
            {!confirmLeave ? (
              <button type="button" className="btn-light btn-small !text-accent" disabled={busy} onClick={() => setConfirmLeave(true)}>
                {strings.leave}
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2" role="alert">
                <span className="text-xs text-muted">{strings.leaveConfirm}</span>
                <button type="button" className="btn-light btn-small" onClick={() => setConfirmLeave(false)}>
                  ✕
                </button>
                <button
                  type="button"
                  className="btn-danger btn-small"
                  disabled={busy}
                  onClick={() => void patch({ state: 'left' })}
                  data-testid={`confirm-leave-${membership.eventId}`}
                >
                  {strings.leave}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </section>
  );
}

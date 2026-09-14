'use client';

import { FacetSelect, TaxonomyPicker, type PickerStrings } from '../../../../../components/taxonomy-picker';
import type { TaxonomyCatalog, UiLocale } from '../../../../../domain/picker';
import type { AudienceFilter } from '../../../../../domain/campaigns';

/**
 * Segment picker for a campaign's `audience_filter`.
 *
 * The five axes are the taxonomy v3 axes; every chip is a TOGGLE and an empty
 * axis means "no constraint". The labels come from the catalogue, the limits
 * from the catalogue (`limitFor`), and the copy is injected by the server page —
 * nothing here duplicates a taxonomy constant.
 */

export interface SegmentStrings {
  title: string;
  hint: string;
  needs: string;
  offers: string;
  interests: string;
  function: string;
  industry: string;
  none: string;
  picker: PickerStrings;
  needHint: string;
  offerHint: string;
  interestsHint: string;
  functionHint: string;
  industryHint: string;
}

export function SegmentPicker({
  catalog,
  locale,
  value,
  onChange,
  strings,
  testId,
}: {
  catalog: TaxonomyCatalog;
  locale: UiLocale;
  value: AudienceFilter;
  onChange: (next: AudienceFilter) => void;
  strings: SegmentStrings;
  testId?: string;
}) {
  const patch = (partial: Partial<AudienceFilter>) => onChange({ ...value, ...partial });
  const empty =
    value.need_intents.length === 0 &&
    value.offer_intents.length === 0 &&
    value.interests.length === 0 &&
    value.job_function === null &&
    value.industry === null;

  return (
    <div className="mt-3 rounded-xl border border-line bg-paper p-3" data-testid={testId}>
      <p className="text-sm font-bold">{strings.title}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-muted">{strings.hint}</p>
      <p className="mt-1 text-xs font-semibold text-pine" data-testid={testId ? `${testId}-state` : undefined}>
        {empty ? strings.none : ''}
      </p>
      <div className="mt-3 flex flex-col gap-5">
        <TaxonomyPicker
          axis="need_intents"
          catalog={catalog}
          locale={locale}
          value={value.need_intents}
          onChange={(next) => patch({ need_intents: next })}
          strings={strings.picker}
          title={strings.needs}
          hint={strings.needHint}
          testId={testId ? `${testId}-needs` : undefined}
          compact
        />
        <TaxonomyPicker
          axis="offer_intents"
          catalog={catalog}
          locale={locale}
          value={value.offer_intents}
          onChange={(next) => patch({ offer_intents: next })}
          strings={strings.picker}
          title={strings.offers}
          hint={strings.offerHint}
          testId={testId ? `${testId}-offers` : undefined}
          compact
        />
        <TaxonomyPicker
          axis="interests"
          catalog={catalog}
          locale={locale}
          value={value.interests}
          onChange={(next) => patch({ interests: next })}
          strings={strings.picker}
          title={strings.interests}
          hint={strings.interestsHint}
          testId={testId ? `${testId}-interests` : undefined}
          compact
        />
        <FacetSelect
          id={testId ? `${testId}-function` : 'segment-function'}
          title={strings.function}
          hint={strings.functionHint}
          catalog={catalog}
          locale={locale}
          kind="functions"
          value={value.job_function}
          onChange={(next) => patch({ job_function: next })}
          strings={strings.picker}
          testId={testId ? `${testId}-function` : undefined}
        />
        <FacetSelect
          id={testId ? `${testId}-industry` : 'segment-industry'}
          title={strings.industry}
          hint={strings.industryHint}
          catalog={catalog}
          locale={locale}
          kind="industries"
          value={value.industry}
          onChange={(next) => patch({ industry: next })}
          strings={strings.picker}
          testId={testId ? `${testId}-industry` : undefined}
        />
      </div>
    </div>
  );
}

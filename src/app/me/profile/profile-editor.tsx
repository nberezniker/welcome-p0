'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TagInput } from '../../../components/tag-input';
import { Toast, useToast } from '../../../components/modal';
import { fill } from '../../../components/fill';
import { FacetSelect, KeywordInput, TaxonomyPicker, type PickerStrings } from '../../../components/taxonomy-picker';
import { EnrichPanel, type EnrichDraft, type EnrichRow, type EnrichStrings } from '../../../components/enrich-panel';
import { labelFor, type TaxonomyCatalog, type UiLocale } from '../../../domain/picker';
import { PUBLIC_FIELD_IDS } from '../../../domain/profile';
import { GoalsPicker } from '../../../components/goals-picker';
import { MAX_GOALS, type GoalId } from '../../../domain/goals';

export interface ProfileFormValues {
  display_name: string;
  headline: string;
  company: string;
  short_bio: string;
  languages: string[];
  offer_tags: string[];
  need_tags: string[];
  need_intents: string[];
  offer_intents: string[];
  interests: string[];
  keywords: string[];
  job_function: string | null;
  industry: string | null;
  /** Field ids withheld from the public card (empty = everything public). */
  hidden_fields: string[];
  /** Private goals (matching v4 §B2), ≤3 in priority order. Never published. */
  goals: string[];
}

type Strings = {
  title: string;
  subtitle: string;
  displayName: string;
  displayNameError: string;
  headline: string;
  headlineError: string;
  company: string;
  companyError: string;
  shortBio: string;
  shortBioError: string;
  languages: string;
  languagesHint: string;
  offerTags: string;
  offerTagsHint: string;
  needTags: string;
  needTagsHint: string;
  tagPlaceholder: string;
  saveProfile: string;
  saving: string;
  savedToast: string;
  conflictTitle: string;
  conflictTextTemplate: string;
  conflictReload: string;
  conflictOverwrite: string;
  slugNoteTemplate: string;
  revisionNoteTemplate: string;
  errorNetwork: string;
  axesTitle: string;
  axesHint: string;
  keywordsLabel: string;
  hiddenFieldsLabel: string;
  hiddenFieldsHint: string;
  enrichTitle: string;
  enrichHint: string;
  enrich: EnrichStrings;
  goals: {
    title: string;
    hint: string;
    limit: string;
    counter: string;
    clear: string;
  };
  picker: PickerStrings;
  pick: {
    needTitle: string;
    needHint: string;
    offerTitle: string;
    offerHint: string;
    interestsTitle: string;
    interestsHint: string;
    keywordsTitle: string;
    keywordsHint: string;
    functionTitle: string;
    functionHint: string;
    industryTitle: string;
    industryHint: string;
  };
  fieldLabels: Record<string, string>;
};

type FieldErrors = Partial<
  Record<'display_name' | 'headline' | 'company' | 'short_bio' | 'languages' | 'tags' | 'axes' | 'revision', string>
>;

const FIELD_ERROR_KEYS: Record<string, keyof Strings> = {
  invalid_display_name: 'displayNameError',
  invalid_headline: 'headlineError',
  invalid_company: 'companyError',
  invalid_short_bio: 'shortBioError',
  invalid_languages: 'languagesHint',
  invalid_tags: 'needTagsHint',
};

/** Errors that belong to the taxonomy block rather than to a single input. */
const AXIS_ERROR_CODES = new Set([
  'invalid_need_intents',
  'invalid_offer_intents',
  'invalid_interests',
  'invalid_keywords',
  'invalid_industry',
  'invalid_job_function',
  'invalid_hidden_fields',
  'invalid_goals',
]);

/**
 * Profile editor with revision-based optimistic concurrency (409 → merge UI).
 * Beyond the v1 fields it edits the three taxonomy axes, the card opt-outs, and
 * offers the same user-confirmed enrichment the onboarding confirm step has.
 */
export function ProfileEditor({
  initial,
  initialRevision,
  slug,
  catalog,
  locale,
  strings,
}: {
  initial: ProfileFormValues;
  /** null = creating for the first time (no revision required by the API). */
  initialRevision: number | null;
  slug: string | null;
  catalog: TaxonomyCatalog;
  locale: UiLocale;
  strings: Strings;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ProfileFormValues>(initial);
  // revision is a SQL bigint; a driver that hands it back as a string would make
  // every save fail with revision_required, so the value is coerced once here.
  const [revision, setRevision] = useState<number | null>(toRevisionOrNull(initialRevision));
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [conflict, setConflict] = useState<{ mine: number; current: number } | null>(null);
  const toast = useToast();

  const set = <K extends keyof ProfileFormValues>(key: K, value: ProfileFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const submit = async (overrideRevision?: number) => {
    setBusy(true);
    setFieldErrors({});
    const useRevision = overrideRevision ?? revision;
    try {
      const body: Record<string, unknown> = {
        display_name: values.display_name,
        headline: values.headline.trim() === '' ? null : values.headline,
        company: values.company.trim() === '' ? null : values.company,
        short_bio: values.short_bio.trim() === '' ? null : values.short_bio,
        languages: values.languages,
        offer_tags: values.offer_tags,
        need_tags: values.need_tags,
        need_intents: values.need_intents,
        offer_intents: values.offer_intents,
        interests: values.interests,
        keywords: values.keywords,
        job_function: values.job_function,
        industry: values.industry,
        hidden_fields: values.hidden_fields,
        goals: values.goals,
      };
      if (useRevision !== null) body['revision'] = toRevisionOrNull(useRevision);
      const res = await fetch('/api/me/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; profile?: { revision?: number }; code?: string }
        | null;

      if (res.ok && payload?.profile) {
        setRevision(toRevisionOrNull(payload.profile.revision));
        setConflict(null);
        toast.show(strings.savedToast);
        router.refresh();
        return;
      }
      if (res.status === 409) {
        const header = res.headers.get('x-current-revision');
        const current = header ? Number(header) : NaN;
        setConflict({ mine: useRevision ?? 0, current: Number.isFinite(current) ? current : 0 });
        return;
      }
      const code = payload?.code ?? '';
      if (AXIS_ERROR_CODES.has(code)) {
        setFieldErrors({ axes: strings.axesHint });
        return;
      }
      const mapped = FIELD_ERROR_KEYS[code];
      if (!mapped) {
        toast.show(strings.errorNetwork, 'error');
        return;
      }
      const field =
        code === 'invalid_display_name'
          ? 'display_name'
          : code === 'invalid_headline'
            ? 'headline'
            : code === 'invalid_company'
              ? 'company'
              : code === 'invalid_short_bio'
                ? 'short_bio'
                : code === 'invalid_languages'
                  ? 'languages'
                  : 'tags';
      setFieldErrors({ [field]: strings[mapped] });
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  const reloadCurrent = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/me/profile');
      const payload = (await res.json().catch(() => null)) as
        | { profile?: (Partial<ProfileFormValues> & { revision: number }) | null }
        | null;
      if (payload?.profile) {
        const p = payload.profile;
        setValues({
          display_name: p.display_name ?? '',
          headline: p.headline ?? '',
          company: p.company ?? '',
          short_bio: p.short_bio ?? '',
          languages: p.languages ?? [],
          offer_tags: p.offer_tags ?? [],
          need_tags: p.need_tags ?? [],
          need_intents: p.need_intents ?? [],
          offer_intents: p.offer_intents ?? [],
          interests: p.interests ?? [],
          keywords: p.keywords ?? [],
          job_function: p.job_function ?? null,
          industry: p.industry ?? null,
          hidden_fields: p.hidden_fields ?? [],
          goals: p.goals ?? [],
        });
        setRevision(toRevisionOrNull(p.revision));
      }
      setConflict(null);
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  const publish = (field: string): boolean => !values.hidden_fields.includes(field);

  const setPublish = (field: string, published: boolean) =>
    set(
      'hidden_fields',
      published
        ? values.hidden_fields.filter((f) => f !== field)
        : [...new Set([...values.hidden_fields, field])],
    );

  /** Draft → rows, labelled with the catalogue the page already loaded. */
  const buildRows = (draft: EnrichDraft): EnrichRow[] => [
    { key: 'headline', label: strings.headline, value: draft.headline ?? '' },
    { key: 'short_bio', label: strings.shortBio, value: draft.short_bio ?? '' },
    { key: 'company', label: strings.company, value: draft.company ?? '' },
    {
      key: 'interests',
      label: strings.pick.interestsTitle,
      value: draft.suggested_interests
        .map((id) => catalog.interests.find((i) => i.id === id))
        .map((i) => (i ? labelFor(i.label, locale) : null))
        .filter((x): x is string => x !== null)
        .join(', '),
    },
    {
      key: 'intents',
      label: `${strings.pick.needTitle} / ${strings.pick.offerTitle}`,
      value: draft.suggested_intents.join(', '),
    },
    { key: 'links', label: strings.enrichTitle, value: draft.links.join(', ') },
  ];

  const applyRow = (row: EnrichRow, draft: EnrichDraft) => {
    switch (row.key) {
      case 'headline':
        if (draft.headline) set('headline', draft.headline);
        return;
      case 'short_bio':
        if (draft.short_bio) set('short_bio', draft.short_bio);
        return;
      case 'company':
        if (draft.company) set('company', draft.company);
        return;
      case 'interests': {
        const next = [...values.interests];
        for (const id of draft.suggested_interests) {
          if (next.length >= catalog.limits.interests) break;
          if (!next.includes(id)) next.push(id);
        }
        set('interests', next);
        return;
      }
      case 'intents': {
        const needs = [...values.need_intents];
        const offers = [...values.offer_intents];
        for (const id of draft.suggested_intents) {
          const isNeed = catalog.intents.some((p) => p.need.id === id);
          const isOffer = catalog.intents.some((p) => p.offer.id === id);
          if (isNeed && needs.length < catalog.limits.need_intents && !needs.includes(id)) needs.push(id);
          else if (isOffer && offers.length < catalog.limits.offer_intents && !offers.includes(id)) offers.push(id);
        }
        set('need_intents', needs);
        set('offer_intents', offers);
        return;
      }
      case 'links':
        // Contacts are managed in /me/contacts (encrypted, per-row public flag);
        // the draft links are not silently written anywhere.
        toast.show(strings.enrichHint);
        return;
      default:
        return;
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      {conflict ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4" role="alert" data-testid="conflict-panel">
          <p className="font-bold text-amber-900">{strings.conflictTitle}</p>
          <p className="mt-1 text-sm text-amber-900">
            {fill(strings.conflictTextTemplate, { mine: conflict.mine, current: conflict.current })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn-light btn-small" disabled={busy} onClick={() => void reloadCurrent()}>
              {strings.conflictReload}
            </button>
            <button
              type="button"
              className="btn-accent btn-small"
              disabled={busy || !conflict.current}
              onClick={() => void submit(conflict.current)}
              data-testid="conflict-overwrite"
            >
              {strings.conflictOverwrite}
            </button>
          </div>
        </div>
      ) : null}

      <div>
        <label className="label" htmlFor="pf-name">
          {strings.displayName} <span className="normal-case text-accent">*</span>
        </label>
        <input
          id="pf-name"
          className="input"
          value={values.display_name}
          onChange={(e) => set('display_name', e.target.value)}
          maxLength={120}
          required
          aria-invalid={fieldErrors.display_name ? true : undefined}
          data-testid="pf-name"
        />
        {fieldErrors.display_name ? <p className="field-error">{fieldErrors.display_name}</p> : null}
      </div>

      <div>
        <label className="label" htmlFor="pf-headline">
          {strings.headline}
        </label>
        <input
          id="pf-headline"
          className="input"
          value={values.headline}
          onChange={(e) => set('headline', e.target.value)}
          maxLength={200}
          aria-invalid={fieldErrors.headline ? true : undefined}
        />
        {fieldErrors.headline ? <p className="field-error">{fieldErrors.headline}</p> : null}
      </div>

      <div>
        <label className="label" htmlFor="pf-company">
          {strings.company}
        </label>
        <input
          id="pf-company"
          className="input"
          value={values.company}
          onChange={(e) => set('company', e.target.value)}
          maxLength={120}
          aria-invalid={fieldErrors.company ? true : undefined}
        />
        {fieldErrors.company ? <p className="field-error">{fieldErrors.company}</p> : null}
      </div>

      <div>
        <label className="label" htmlFor="pf-bio">
          {strings.shortBio}
        </label>
        <textarea
          id="pf-bio"
          className="input min-h-24"
          value={values.short_bio}
          onChange={(e) => set('short_bio', e.target.value)}
          maxLength={1000}
          aria-invalid={fieldErrors.short_bio ? true : undefined}
        />
        {fieldErrors.short_bio ? <p className="field-error">{fieldErrors.short_bio}</p> : null}
      </div>

      <TagInput
        id="pf-languages"
        label={strings.languages}
        hint={strings.languagesHint}
        values={values.languages}
        onChange={(next) => set('languages', next.slice(0, 10))}
        placeholder={strings.tagPlaceholder}
        max={10}
      />

      {/* Taxonomy v3 — the axes search and recommendations are built on. */}
      <fieldset className="flex flex-col gap-5 border-t border-line pt-4">
        <legend className="text-sm font-bold">{strings.axesTitle}</legend>
        <p className="text-xs text-muted">{strings.axesHint}</p>
        {fieldErrors.axes ? <p className="field-error">{fieldErrors.axes}</p> : null}

        <TaxonomyPicker
          axis="need_intents"
          catalog={catalog}
          locale={locale}
          value={values.need_intents}
          onChange={(next) => set('need_intents', next)}
          strings={strings.picker}
          title={strings.pick.needTitle}
          hint={strings.pick.needHint.replace('{max}', String(catalog.limits.need_intents))}
          testId="pf-needs"
        />
        <TaxonomyPicker
          axis="offer_intents"
          catalog={catalog}
          locale={locale}
          value={values.offer_intents}
          onChange={(next) => set('offer_intents', next)}
          strings={strings.picker}
          title={strings.pick.offerTitle}
          hint={strings.pick.offerHint.replace('{max}', String(catalog.limits.offer_intents))}
          testId="pf-offers"
        />
        <TaxonomyPicker
          axis="interests"
          catalog={catalog}
          locale={locale}
          value={values.interests}
          onChange={(next) => set('interests', next)}
          strings={strings.picker}
          title={strings.pick.interestsTitle}
          hint={strings.pick.interestsHint.replace('{max}', String(catalog.limits.interests))}
          testId="pf-interests"
        />
        {/* Goals are private and shape only this user's recommendations — they
            sit with the axes, but are never part of the public card. */}
        <GoalsPicker
          value={values.goals}
          onChange={(next: GoalId[]) => set('goals', next)}
          locale={locale}
          strings={{
            title: strings.goals.title,
            hint: strings.goals.hint,
            limit: strings.goals.limit,
            counter: strings.goals.counter
              .replace('{n}', String(values.goals.length))
              .replace('{max}', String(MAX_GOALS)),
            clear: strings.goals.clear,
          }}
          testId="pf-goals"
        />
        <KeywordInput
          id="pf-keywords"
          title={strings.keywordsLabel}
          hint={strings.pick.keywordsHint
            .replace('{max}', String(catalog.limits.keywords))
            .replace('{length}', String(catalog.limits.keyword_length))}
          values={values.keywords}
          onChange={(next) => set('keywords', next)}
          strings={strings.picker}
          max={catalog.limits.keywords}
          maxLength={catalog.limits.keyword_length}
          testId="pf-keywords"
        />
        <FacetSelect
          id="pf-function"
          title={strings.pick.functionTitle}
          hint={strings.pick.functionHint}
          catalog={catalog}
          locale={locale}
          kind="functions"
          value={values.job_function}
          onChange={(next) => set('job_function', next)}
          strings={strings.picker}
          testId="pf-function"
        />
        <FacetSelect
          id="pf-industry"
          title={strings.pick.industryTitle}
          hint={strings.pick.industryHint}
          catalog={catalog}
          locale={locale}
          kind="industries"
          value={values.industry}
          onChange={(next) => set('industry', next)}
          strings={strings.picker}
          testId="pf-industry"
        />
      </fieldset>

      {/* Legacy v1 tags stay editable: the frozen tag matcher still uses them. */}
      <TagInput
        id="pf-offer"
        label={strings.offerTags}
        hint={strings.offerTagsHint}
        values={values.offer_tags}
        onChange={(next) => set('offer_tags', next)}
        placeholder={strings.tagPlaceholder}
      />

      <TagInput
        id="pf-need"
        label={strings.needTags}
        hint={strings.needTagsHint}
        values={values.need_tags}
        onChange={(next) => set('need_tags', next)}
        placeholder={strings.tagPlaceholder}
      />

      <div className="border-t border-line pt-4">
        <p className="text-sm font-bold">{strings.enrichTitle}</p>
        <p className="mt-0.5 text-xs text-muted">{strings.enrichHint}</p>
        <div className="mt-3">
          <EnrichPanel strings={strings.enrich} buildRows={buildRows} onApply={applyRow} testId="pf-enrich" />
        </div>
      </div>

      <fieldset className="border-t border-line pt-4">
        <legend className="text-sm font-bold">{strings.hiddenFieldsLabel}</legend>
        <p className="mt-0.5 text-xs text-muted">{strings.hiddenFieldsHint}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {PUBLIC_FIELD_IDS.map((field) => (
            <label key={field} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4"
                checked={publish(field)}
                onChange={(e) => setPublish(field, e.target.checked)}
                data-testid={`pf-publish-${field}`}
              />
              <span>{strings.fieldLabels[field] ?? field}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" className="btn-primary" disabled={busy} data-testid="pf-save">
          {busy ? strings.saving : strings.saveProfile}
        </button>
        {slug ? <span className="text-xs text-muted">{fill(strings.slugNoteTemplate, { slug })}</span> : null}
        {revision !== null ? (
          <span className="text-xs text-muted">{fill(strings.revisionNoteTemplate, { n: revision })}</span>
        ) : null}
      </div>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </form>
  );
}

/** Coerces a driver value into the integer the API requires (null = create path). */
function toRevisionOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

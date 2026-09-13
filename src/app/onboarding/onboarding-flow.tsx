'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FacetSelect, KeywordInput, TaxonomyPicker, type PickerStrings } from '../../components/taxonomy-picker';
import { Toast, useToast } from '../../components/modal';
import { fill } from '../../components/fill';
import { detectLinkKind, LINK_EXAMPLES, validateLink, type LinkKind } from '../../domain/links';
import { hiddenFromPublish, parseDraft, serializeDraft, ONBOARDING_DRAFT_KEY, ONBOARDING_STEPS, type OnboardingDraftValues } from '../../domain/onboarding-draft';
import { labelFor, type TaxonomyCatalog, type UiLocale } from '../../domain/picker';
import { MAX_ENRICHMENT_LINKS } from '../../domain/enrichment-limits';
import { EnrichPanel, type EnrichDraft, type EnrichRow, type EnrichStrings } from '../../components/enrich-panel';

export interface OnboardingStrings {
  title: string;
  subtitle: string;
  progress: string;
  step1Title: string;
  step2Title: string;
  step3Title: string;
  step4Title: string;
  nameLabel: string;
  nameError: string;
  headlineLabel: string;
  companyLabel: string;
  bioLabel: string;
  languagesLabel: string;
  languagesHint: string;
  back: string;
  next: string;
  nextNeedsName: string;
  draftRestored: string;
  draftReset: string;
  linksTitle: string;
  linksHint: string;
  linkInvalid: string;
  publishTitle: string;
  publishHint: string;
  publishCta: string;
  publishing: string;
  saveError: string;
  contactSaveError: string;
  enrich: EnrichStrings;
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
  /** Publish checkboxes: field id → label. */
  fieldLabels: Record<string, string>;
  kindLabels: Record<LinkKind, string>;
  errorNetwork: string;
  errorGeneric: string;
}

/** Public field ids in the order the publish list shows them. */
const PUBLISH_FIELDS = [
  'headline',
  'company',
  'short_bio',
  'languages',
  'need_intents',
  'offer_intents',
  'interests',
  'keywords',
] as const;

const LINK_FIELDS: readonly LinkKind[] = ['linkedin_url', 'website', 'github_url', 'telegram_username', 'whatsapp'];

/**
 * Onboarding: three questions, then a confirm step where every value is applied
 * BY HAND. Nothing is written to the profile — and nothing reaches the public
 * card — before the user presses "Publish".
 *
 * Enrichment (POST /api/me/enrich) is a draft: it is rendered per field with its
 * own "Apply" button and its source list, never merged silently.
 */
export function OnboardingFlow({
  catalog,
  locale,
  strings,
}: {
  catalog: TaxonomyCatalog;
  locale: UiLocale;
  strings: OnboardingStrings;
}) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [values, setValues] = useState<OnboardingDraftValues>({
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
  });
  const [links, setLinks] = useState<Partial<Record<LinkKind, string>>>({});
  const [linkErrors, setLinkErrors] = useState<Partial<Record<LinkKind, string>>>({});
  const [publish, setPublish] = useState<Record<string, boolean>>(() => defaultPublish());
  const [publishing, setPublishing] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const hydrated = useRef(false);

  // ── draft: restore once after hydration, persist on every change ───────────
  // Deliberately deferred to a microtask: localStorage is not available while
  // rendering on the server, so reading it during the first render would either
  // crash or produce a hydration mismatch. One tick later the markup is already
  // committed and a state update is safe.
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const raw = window.localStorage.getItem(ONBOARDING_DRAFT_KEY);
        const draft = raw ? parseDraft(raw) : null;
        if (draft) {
          setValues(draft.values);
          setLinks(draft.links);
          setStep(draft.step);
          // A restored draft carries the opt-outs the user already chose.
          setPublish((prev) => {
            const next = { ...prev };
            for (const field of draft.hidden_fields) next[field] = false;
            return next;
          });
          setRestored(
            draft.values.display_name.length > 0 ||
              draft.values.headline.length > 0 ||
              Object.keys(draft.links).length > 0,
          );
        }
      } catch {
        // Private mode / disabled storage: the wizard still works, just without a draft.
      } finally {
        hydrated.current = true;
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(
        ONBOARDING_DRAFT_KEY,
        serializeDraft({ step, values, links, hidden_fields: hiddenFromPublish(publish) }),
      );
    } catch {
      // ignore quota/private-mode failures
    }
  }, [step, values, links, publish]);

  const set = <K extends keyof OnboardingDraftValues>(key: K, value: OnboardingDraftValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const setLink = (kind: LinkKind, value: string) => {
    setLinks((l) => ({ ...l, [kind]: value }));
    if (value.trim().length === 0) {
      setLinkErrors((e) => ({ ...e, [kind]: undefined }));
      return;
    }
    const result = validateLink(value, kind);
    setLinkErrors((e) => ({
      ...e,
      [kind]: result.ok
        ? undefined
        : fill(strings.linkInvalid, {
            kind: strings.kindLabels[kind],
            example: LINK_EXAMPLES[kind],
          }),
    }));
  };

  const setPublishFlag = (field: string, published: boolean) =>
    setPublish((p) => ({ ...p, [field]: published }));

  /** One draft row applied by hand. The panel never writes to the form itself. */
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
        set('interests', mergeCapped(values.interests, draft.suggested_interests, catalog.limits.interests));
        return;
      }
      case 'intents': {
        const needs = draft.suggested_intents.filter((id) => catalog.intents.some((p) => p.need.id === id));
        const offers = draft.suggested_intents.filter((id) => catalog.intents.some((p) => p.offer.id === id));
        set('need_intents', mergeCapped(values.need_intents, needs, catalog.limits.need_intents));
        set('offer_intents', mergeCapped(values.offer_intents, offers, catalog.limits.offer_intents));
        return;
      }
      case 'links': {
        const next = { ...links };
        for (const url of draft.links.slice(0, MAX_ENRICHMENT_LINKS)) {
          const kind = detectLinkKind(url);
          if (!next[kind]) next[kind] = url;
        }
        setLinks(next);
        for (const [kind, value] of Object.entries(next)) {
          if (typeof value === 'string') setLink(kind as LinkKind, value);
        }
        return;
      }
      default:
        return;
    }
  };

  /** Draft → rows. The parent owns the labels, so the panel stays catalogue-free. */
  const buildRows = (draft: EnrichDraft): EnrichRow[] => [
    { key: 'headline', label: strings.headlineLabel, value: draft.headline ?? '' },
    { key: 'short_bio', label: strings.bioLabel, value: draft.short_bio ?? '' },
    { key: 'company', label: strings.companyLabel, value: draft.company ?? '' },
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
    { key: 'links', label: strings.linksTitle, value: draft.links.join(', ') },
  ];

  // ── publish ────────────────────────────────────────────────────────────────
  const publishCard = async () => {
    if (values.display_name.trim().length === 0) {
      setNameError(strings.nameError);
      setStep(1);
      return;
    }
    setPublishing(true);
    setNameError(null);
    try {
      const res = await fetch('/api/me/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          display_name: values.display_name.trim(),
          headline: blankToNull(values.headline),
          company: blankToNull(values.company),
          short_bio: blankToNull(values.short_bio),
          languages: values.languages,
          offer_tags: [],
          need_tags: [],
          need_intents: values.need_intents,
          offer_intents: values.offer_intents,
          interests: values.interests,
          industry: values.industry,
          job_function: values.job_function,
          keywords: values.keywords,
          hidden_fields: hiddenFromPublish(publish),
        }),
      });
      const body = (await res.json().catch(() => null)) as { profile?: { public_slug?: string } } | null;
      const slug = body?.profile?.public_slug;
      if (!res.ok || !slug) {
        toast.show(strings.saveError, 'error');
        return;
      }

      // Links are separate rows; a failure here must not lose the card, so the
      // user is told exactly which kinds to redo (they stay on the page).
      const failed: string[] = [];
      for (const kind of LINK_FIELDS) {
        const raw = links[kind]?.trim();
        if (!raw) continue;
        const valid = validateLink(raw, kind);
        if (!valid.ok) {
          failed.push(strings.kindLabels[kind]);
          continue;
        }
        try {
          const contactRes = await fetch('/api/me/contacts', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              kind: valid.kind,
              value: valid.normalized,
              public_enabled: publish[valid.kind] !== false,
            }),
          });
          if (!contactRes.ok) failed.push(strings.kindLabels[kind]);
        } catch {
          failed.push(strings.kindLabels[kind]);
        }
      }
      if (failed.length > 0) {
        toast.show(fill(strings.contactSaveError, { kinds: failed.join(', ') }), 'error');
      }

      try {
        window.localStorage.removeItem(ONBOARDING_DRAFT_KEY);
      } catch {
        // ignore
      }
      router.push(`/p/${slug}`);
      router.refresh();
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setPublishing(false);
    }
  };

  const progress = fill(strings.progress, { n: step, total: ONBOARDING_STEPS });

  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{strings.title}</h1>
      <p className="mt-1.5 text-sm text-muted">{strings.subtitle}</p>

      {/* Stepper: numbered, progressbar semantics, one dot per question. */}
      <div className="mt-5 flex items-center gap-3" data-testid="onboarding-progress">
        <div
          role="progressbar"
          aria-valuenow={step}
          aria-valuemin={1}
          aria-valuemax={ONBOARDING_STEPS}
          aria-label={progress}
          className="h-3 flex-1 overflow-hidden rounded-full bg-paper"
        >
          <div className="h-full rounded-full bg-pine" style={{ width: `${(step / ONBOARDING_STEPS) * 100}%` }} />
        </div>
        <span className="text-sm font-bold tabular-nums">{progress}</span>
      </div>

      {restored ? (
        <p className="mt-3 rounded-lg bg-mint px-3 py-2 text-xs font-semibold text-pine" role="status" data-testid="onboarding-draft-restored">
          {strings.draftRestored}
        </p>
      ) : null}

      <div className="card mt-4">
        {step === 1 ? (
          <section aria-labelledby="ob-step1" data-testid="onboarding-step1">
            <h2 id="ob-step1" className="text-lg font-bold tracking-tight">
              {strings.step1Title}
            </h2>
            <div className="mt-4 flex flex-col gap-4">
              <div>
                <label className="label" htmlFor="ob-name">
                  {strings.nameLabel} <span className="normal-case text-accent">*</span>
                </label>
                <input
                  id="ob-name"
                  className="input"
                  value={values.display_name}
                  maxLength={120}
                  required
                  aria-invalid={nameError ? true : undefined}
                  onChange={(e) => {
                    set('display_name', e.target.value);
                    setNameError(null);
                  }}
                  data-testid="ob-name"
                />
                {nameError ? <p className="field-error">{nameError}</p> : null}
              </div>
              <div>
                <label className="label" htmlFor="ob-headline">
                  {strings.headlineLabel}
                </label>
                <input
                  id="ob-headline"
                  className="input"
                  value={values.headline}
                  maxLength={200}
                  onChange={(e) => set('headline', e.target.value)}
                  data-testid="ob-headline"
                />
              </div>
              <div>
                <label className="label" htmlFor="ob-company">
                  {strings.companyLabel}
                </label>
                <input
                  id="ob-company"
                  className="input"
                  value={values.company}
                  maxLength={120}
                  onChange={(e) => set('company', e.target.value)}
                  data-testid="ob-company"
                />
              </div>
              <FacetSelect
                id="ob-function"
                title={strings.pick.functionTitle}
                hint={strings.pick.functionHint}
                catalog={catalog}
                locale={locale}
                kind="functions"
                value={values.job_function}
                onChange={(next) => set('job_function', next)}
                strings={strings.picker}
                testId="ob-function"
              />
              <FacetSelect
                id="ob-industry"
                title={strings.pick.industryTitle}
                hint={strings.pick.industryHint}
                catalog={catalog}
                locale={locale}
                kind="industries"
                value={values.industry}
                onChange={(next) => set('industry', next)}
                strings={strings.picker}
                testId="ob-industry"
              />
              <div>
                <label className="label" htmlFor="ob-bio">
                  {strings.bioLabel}
                </label>
                <textarea
                  id="ob-bio"
                  className="input min-h-24"
                  value={values.short_bio}
                  maxLength={1000}
                  onChange={(e) => set('short_bio', e.target.value)}
                  data-testid="ob-bio"
                />
              </div>
              <KeywordInput
                id="ob-languages"
                title={strings.languagesLabel}
                hint={strings.languagesHint}
                values={values.languages}
                onChange={(next) => set('languages', next)}
                strings={strings.picker}
                max={10}
                maxLength={30}
                testId="ob-languages"
              />
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section aria-labelledby="ob-step2" data-testid="onboarding-step2">
            <h2 id="ob-step2" className="text-lg font-bold tracking-tight">
              {strings.step2Title}
            </h2>
            <div className="mt-4 flex flex-col gap-6">
              <TaxonomyPicker
                axis="need_intents"
                catalog={catalog}
                locale={locale}
                value={values.need_intents}
                onChange={(next) => set('need_intents', next)}
                strings={strings.picker}
                title={strings.pick.needTitle}
                hint={strings.pick.needHint.replace('{max}', String(catalog.limits.need_intents))}
                testId="ob-needs"
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
                testId="ob-interests"
              />
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section aria-labelledby="ob-step3" data-testid="onboarding-step3">
            <h2 id="ob-step3" className="text-lg font-bold tracking-tight">
              {strings.step3Title}
            </h2>
            <div className="mt-4 flex flex-col gap-6">
              <TaxonomyPicker
                axis="offer_intents"
                catalog={catalog}
                locale={locale}
                value={values.offer_intents}
                onChange={(next) => set('offer_intents', next)}
                strings={strings.picker}
                title={strings.pick.offerTitle}
                hint={strings.pick.offerHint.replace('{max}', String(catalog.limits.offer_intents))}
                testId="ob-offers"
              />
              <KeywordInput
                id="ob-keywords"
                title={strings.pick.keywordsTitle}
                hint={strings.pick.keywordsHint
                  .replace('{max}', String(catalog.limits.keywords))
                  .replace('{length}', String(catalog.limits.keyword_length))}
                values={values.keywords}
                onChange={(next) => set('keywords', next)}
                strings={strings.picker}
                max={catalog.limits.keywords}
                maxLength={catalog.limits.keyword_length}
                testId="ob-keywords"
              />
            </div>
          </section>
        ) : null}

        {step === 4 ? (
          <section aria-labelledby="ob-step4" data-testid="onboarding-step4">
            <h2 id="ob-step4" className="text-lg font-bold tracking-tight">
              {strings.step4Title}
            </h2>

            <div className="mt-4">
              <EnrichPanel
                strings={strings.enrich}
                buildRows={buildRows}
                onApply={applyRow}
                testId="ob-enrich"
              />
            </div>

            <div className="mt-6">
              <p className="text-sm font-bold">{strings.linksTitle}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{strings.linksHint}</p>
              <div className="mt-3 flex flex-col gap-3">
                {LINK_FIELDS.map((kind) => (
                  <div key={kind}>
                    <label className="label" htmlFor={`ob-link-${kind}`}>
                      {strings.kindLabels[kind]}
                    </label>
                    <input
                      id={`ob-link-${kind}`}
                      className="input"
                      value={links[kind] ?? ''}
                      maxLength={300}
                      placeholder={LINK_EXAMPLES[kind]}
                      aria-invalid={linkErrors[kind] ? true : undefined}
                      onChange={(e) => setLink(kind, e.target.value)}
                      data-testid={`ob-link-${kind}`}
                    />
                    {linkErrors[kind] ? <p className="field-error">{linkErrors[kind]}</p> : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 border-t border-line pt-4">
              <p className="text-sm font-bold">{strings.publishTitle}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{strings.publishHint}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {[...PUBLISH_FIELDS, ...LINK_FIELDS].map((field) => (
                  <label key={field} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 size-4"
                      checked={publish[field] !== false}
                      onChange={(e) => setPublishFlag(field, e.target.checked)}
                      data-testid={`ob-publish-${field}`}
                    />
                    <span>{strings.fieldLabels[field] ?? strings.kindLabels[field as LinkKind] ?? field}</span>
                  </label>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {step > 1 ? (
            <button type="button" className="btn-light" onClick={() => setStep((s) => s - 1)} data-testid="ob-back">
              {strings.back}
            </button>
          ) : null}
          {step < ONBOARDING_STEPS ? (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                if (step === 1 && values.display_name.trim().length === 0) {
                  setNameError(strings.nextNeedsName);
                  return;
                }
                setStep((s) => s + 1);
              }}
              data-testid="ob-next"
            >
              {strings.next}
            </button>
          ) : (
            <button
              type="button"
              className="btn-accent"
              disabled={publishing}
              onClick={() => void publishCard()}
              data-testid="ob-publish"
            >
              {publishing ? strings.publishing : strings.publishCta}
            </button>
          )}
          <button
            type="button"
            className="btn-light btn-small"
            onClick={() => {
              setValues({
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
              });
              setLinks({});
              setPublish(defaultPublish());
              setStep(1);
              setRestored(false);
            }}
            data-testid="ob-reset"
          >
            {strings.draftReset}
          </button>
        </div>
        <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
      </div>
    </div>
  );
}

/** Draft suggestions must respect the catalogue limits, never exceed them. */
function mergeCapped(current: string[], incoming: string[], limit: number): string[] {
  const out = [...current];
  for (const id of incoming) {
    if (out.length >= limit) break;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Every public field starts published (the pre-008 default). */
function defaultPublish(): Record<string, boolean> {
  return Object.fromEntries([...PUBLISH_FIELDS, ...LINK_FIELDS].map((field) => [field, true]));
}

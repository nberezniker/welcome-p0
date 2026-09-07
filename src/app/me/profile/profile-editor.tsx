'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TagInput } from '../../../components/tag-input';
import { Toast, useToast } from '../../../components/modal';

export interface ProfileFormValues {
  display_name: string;
  headline: string;
  company: string;
  short_bio: string;
  languages: string[];
  offer_tags: string[];
  need_tags: string[];
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
  conflictText: (mine: string, current: string) => string;
  conflictReload: string;
  conflictOverwrite: string;
  slugNote: (slug: string) => string;
  revisionNote: (n: number) => string;
  errorNetwork: string;
};

type FieldErrors = Partial<Record<'display_name' | 'headline' | 'company' | 'short_bio' | 'languages' | 'tags' | 'revision', string>>;

const FIELD_ERROR_KEYS: Record<string, keyof Strings> = {
  invalid_display_name: 'displayNameError',
  invalid_headline: 'headlineError',
  invalid_company: 'companyError',
  invalid_short_bio: 'shortBioError',
  invalid_languages: 'languagesHint',
  invalid_tags: 'needTagsHint',
  revision_required: 'savedToast',
};

/** Profile editor with revision-based optimistic concurrency (409 → merge UI). */
export function ProfileEditor({
  initial,
  initialRevision,
  slug,
  strings,
}: {
  initial: ProfileFormValues;
  /** null = creating for the first time (no revision required by the API). */
  initialRevision: number | null;
  slug: string | null;
  strings: Strings;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ProfileFormValues>(initial);
  const [revision, setRevision] = useState<number | null>(initialRevision);
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
      };
      if (useRevision !== null) body['revision'] = useRevision;
      const res = await fetch('/api/me/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; profile?: { revision?: number }; code?: string }
        | null;

      if (res.ok && payload?.profile) {
        setRevision(payload.profile.revision ?? null);
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
      const mapped = FIELD_ERROR_KEYS[code];
      if (mapped) {
        setFieldErrors({ [code === 'invalid_display_name' ? 'display_name' : code === 'invalid_headline' ? 'headline' : code === 'invalid_company' ? 'company' : code === 'invalid_short_bio' ? 'short_bio' : code === 'invalid_languages' ? 'languages' : code === 'invalid_tags' ? 'tags' : 'revision']: strings[mapped] });
      } else {
        toast.show(strings.errorNetwork, 'error');
      }
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
        | { profile?: ProfileFormValues & { revision: number } | null }
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
        });
        setRevision(p.revision ?? null);
      }
      setConflict(null);
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
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
          <p className="mt-1 text-sm text-amber-900">{strings.conflictText(String(conflict.mine), String(conflict.current))}</p>
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

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" className="btn-primary" disabled={busy} data-testid="pf-save">
          {busy ? strings.saving : strings.saveProfile}
        </button>
        {slug ? <span className="text-xs text-muted">{strings.slugNote(slug)}</span> : null}
        {revision !== null ? <span className="text-xs text-muted">{strings.revisionNote(revision)}</span> : null}
      </div>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </form>
  );
}

import type { Metadata } from 'next';
import { getSql } from '../../../lib/db';
import { requireAccountId } from '../../../lib/session-page';
import { getT } from '../../../i18n';
import { taxonomyPayload } from '../../../domain/taxonomy';
import { parseCatalog } from '../../../domain/picker';
import { ProfileEditor } from './profile-editor';

export const metadata: Metadata = { title: 'Профиль', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function ProfileEditorPage() {
  const accountId = await requireAccountId('/me/profile');
  const { locale, t } = await getT();
  const sql = getSql();
  const rows = await sql<{
    public_slug: string;
    display_name: string;
    headline: string | null;
    company: string | null;
    short_bio: string | null;
    languages: string[];
    offer_tags: string[];
    need_tags: string[];
    need_intents: string[];
    offer_intents: string[];
    interests: string[];
    keywords: string[];
    industry: string | null;
    job_function: string | null;
    hidden_fields: string[];
    goals: string[];
    revision: number;
  }[]>`SELECT public_slug, display_name, headline, company, short_bio, languages, offer_tags, need_tags,
             need_intents, offer_intents, interests, keywords, industry, job_function, hidden_fields, goals,
             revision::int AS revision
    FROM profiles WHERE account_id = ${accountId} LIMIT 1`;
  const profile = rows[0] ?? null;

  // The catalogue is a local module — no client round-trip, and the pickers on
  // this page get their limits from it (never from a duplicated constant).
  const catalog = parseCatalog(taxonomyPayload());
  if (!catalog) throw new Error('taxonomy catalogue payload is unusable');

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{t('profile.title')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('profile.subtitle')}</p>
      <div className="card mt-6">
        <ProfileEditor
          slug={profile?.public_slug ?? null}
          initialRevision={profile?.revision ?? null}
          catalog={catalog}
          locale={locale}
          initial={{
            display_name: profile?.display_name ?? '',
            headline: profile?.headline ?? '',
            company: profile?.company ?? '',
            short_bio: profile?.short_bio ?? '',
            languages: profile?.languages ?? [],
            offer_tags: profile?.offer_tags ?? [],
            need_tags: profile?.need_tags ?? [],
            need_intents: profile?.need_intents ?? [],
            offer_intents: profile?.offer_intents ?? [],
            interests: profile?.interests ?? [],
            keywords: profile?.keywords ?? [],
            job_function: profile?.job_function ?? null,
            industry: profile?.industry ?? null,
            hidden_fields: profile?.hidden_fields ?? [],
            goals: profile?.goals ?? [],
          }}
          strings={{
            title: t('profile.title'),
            subtitle: t('profile.subtitle'),
            displayName: t('profile.displayName'),
            displayNameError: t('profile.displayNameError'),
            headline: t('profile.headline'),
            headlineError: t('profile.headlineError'),
            company: t('profile.company'),
            companyError: t('profile.companyError'),
            shortBio: t('profile.shortBio'),
            shortBioError: t('profile.shortBioError'),
            languages: t('profile.languages'),
            languagesHint: t('profile.languagesHint'),
            offerTags: t('profile.offerTags'),
            offerTagsHint: t('profile.offerTagsHint'),
            needTags: t('profile.needTags'),
            needTagsHint: t('profile.needTagsHint'),
            tagPlaceholder: t('profile.tagPlaceholder'),
            saveProfile: t('profile.saveProfile'),
            saving: t('common.saving'),
            savedToast: t('profile.savedToast'),
            conflictTitle: t('profile.conflictTitle'),
            conflictTextTemplate: t('profile.conflictText'),
            conflictReload: t('profile.conflictReload'),
            conflictOverwrite: t('profile.conflictOverwrite'),
            slugNoteTemplate: t('profile.slugNote'),
            revisionNoteTemplate: t('profile.revisionNote'),
            errorNetwork: t('common.errorNetwork'),
            axesTitle: t('profile.axesTitle'),
            axesHint: t('profile.axesHint'),
            keywordsLabel: t('profile.keywordsLabel'),
            hiddenFieldsLabel: t('profile.hiddenFieldsLabel'),
            hiddenFieldsHint: t('profile.hiddenFieldsHint'),
            enrichTitle: t('profile.enrichTitle'),
            enrichHint: t('profile.enrichHint'),
            enrich: {
              cta: t('enrich.cta'),
              busy: t('enrich.busy'),
              hint: t('enrich.hint'),
              sources: t('enrich.sources'),
              suggested: t('enrich.suggested'),
              apply: t('enrich.apply'),
              applied: t('enrich.applied'),
              noDraft: t('enrich.noDraft'),
              rateLimited: t('enrich.rateLimited'),
              disabled: t('enrich.disabled'),
              failed: t('enrich.failed'),
              retry: t('enrich.retry'),
              privacyNote: t('enrich.privacyNote'),
              errorNetwork: t('common.errorNetwork'),
            },
            goals: {
              title: t('goals.title'),
              hint: t('goals.hint'),
              limit: t('goals.limit'),
              counter: t('goals.counter'),
              clear: t('goals.clear'),
            },
            picker: {
              searchPlaceholder: t('pick.searchPlaceholder'),
              selected: t('pick.selected'),
              limitReached: t('pick.limitReached'),
              noResults: t('pick.noResults'),
              clear: t('pick.clear'),
              remove: t('pick.remove'),
              keywordPlaceholder: t('pick.keywordPlaceholder'),
              keywordTooLong: t('pick.keywordTooLong'),
              unspecified: t('pick.unspecified'),
            },
            pick: {
              needTitle: t('pick.needTitle'),
              needHint: t('pick.needHint'),
              offerTitle: t('pick.offerTitle'),
              offerHint: t('pick.offerHint'),
              interestsTitle: t('pick.interestsTitle'),
              interestsHint: t('pick.interestsHint'),
              keywordsTitle: t('pick.keywordsTitle'),
              keywordsHint: t('pick.keywordsHint'),
              functionTitle: t('pick.functionTitle'),
              functionHint: t('pick.functionHint'),
              industryTitle: t('pick.industryTitle'),
              industryHint: t('pick.industryHint'),
            },
            fieldLabels: {
              headline: t('profile.headline'),
              company: t('profile.company'),
              short_bio: t('profile.shortBio'),
              languages: t('profile.languages'),
              offer_tags: t('profile.offerTags'),
              need_tags: t('profile.needTags'),
              need_intents: t('pick.needTitle'),
              offer_intents: t('pick.offerTitle'),
              interests: t('pick.interestsTitle'),
              keywords: t('profile.keywordsLabel'),
            },
          }}
        />
      </div>
    </div>
  );
}

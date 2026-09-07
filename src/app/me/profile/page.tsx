import type { Metadata } from 'next';
import { getSql } from '../../../lib/db';
import { requireAccountId } from '../../../lib/session-page';
import { getT } from '../../../i18n';
import { ProfileEditor } from './profile-editor';

export const metadata: Metadata = { title: 'Профиль', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function ProfileEditorPage() {
  const accountId = await requireAccountId('/me/profile');
  const { t } = await getT();
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
    revision: number;
  }[]>`SELECT public_slug, display_name, headline, company, short_bio, languages, offer_tags, need_tags, revision
    FROM profiles WHERE account_id = ${accountId} LIMIT 1`;
  const profile = rows[0] ?? null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{t('profile.title')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('profile.subtitle')}</p>
      <div className="card mt-6">
        <ProfileEditor
          slug={profile?.public_slug ?? null}
          initialRevision={profile?.revision ?? null}
          initial={{
            display_name: profile?.display_name ?? '',
            headline: profile?.headline ?? '',
            company: profile?.company ?? '',
            short_bio: profile?.short_bio ?? '',
            languages: profile?.languages ?? [],
            offer_tags: profile?.offer_tags ?? [],
            need_tags: profile?.need_tags ?? [],
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
            conflictText: (mine, current) => t('profile.conflictText', { mine, current }),
            conflictReload: t('profile.conflictReload'),
            conflictOverwrite: t('profile.conflictOverwrite'),
            slugNote: (slug) => t('profile.slugNote', { slug }),
            revisionNote: (n) => t('profile.revisionNote', { n }),
            errorNetwork: t('common.errorNetwork'),
          }}
        />
      </div>
    </div>
  );
}

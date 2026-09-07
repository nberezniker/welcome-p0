import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '../../../../../lib/db';
import { requireAccountId } from '../../../../../lib/session-page';
import { getT } from '../../../../../i18n';
import { DirectoryPanel } from './directory-panel';

export const metadata: Metadata = { title: 'Каталог', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function EventDirectoryPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const accountId = await requireAccountId(`/me/events/${eventId}/directory`);
  const { t } = await getT();
  const sql = getSql();

  // The event must exist; directory access itself is enforced by the API.
  const eventRows = await sql<{ id: string; name: string; slug: string }[]>`
    SELECT id, name, slug FROM events WHERE id = ${eventId} OR slug = ${eventId} LIMIT 1`;
  const event = eventRows[0];
  if (!event) notFound();

  // Viewer visibility state for the honest note (own membership only).
  const visRows = await sql<{ directory_visible: boolean; state: string }[]>`
    SELECT m.directory_visible, m.state
    FROM event_memberships m JOIN profiles p ON p.id = m.profile_id
    WHERE m.event_id = ${event.id} AND p.account_id = ${accountId} LIMIT 1`;
  const mine = visRows[0] ?? null;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight">{t('directory.title')}</h1>
        <Link href={`/e/${event.slug}`} className="btn-light btn-small">
          ← {t('directory.backToEvent')}: {event.name}
        </Link>
      </div>
      <p className="mt-1.5 text-sm text-muted">{t('directory.subtitle')}</p>
      {mine && (mine.state !== 'active' || !mine.directory_visible) ? (
        <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-900" role="status">
          {t('directory.notVisibleNote')}
        </p>
      ) : null}
      <div className="mt-6">
        <DirectoryPanel
          eventId={event.id}
          kindLabels={{
            whatsapp: t('contacts.kind.whatsapp'),
            telegram_username: t('contacts.kind.telegram_username'),
            linkedin_url: t('contacts.kind.linkedin_url'),
            website: t('contacts.kind.website'),
            phone: t('contacts.kind.phone'),
          }}
          strings={{
            loading: t('common.loading'),
            empty: t('directory.empty'),
            closed: t('directory.closed'),
            membersTitle: t('directory.title'),
            proposeIntro: t('directory.proposeIntro'),
            proposed: t('directory.proposed'),
            introSentToast: t('directory.introSentToast'),
            introAlready: t('directory.introAlready'),
            revealChooserTitleTemplate: t('directory.revealChooserTitle'),
            revealChooserHint: t('directory.revealChooserHint'),
            sendRequest: t('directory.sendRequest'),
            sending: t('common.saving'),
            recommendationsTitle: t('directory.recommendationsTitle'),
            recommendationsEmpty: t('directory.recommendationsEmpty'),
            scoreTemplate: t('directory.score'),
            reasonsForMeTemplate: t('directory.reasonsForMe'),
            reasonsForThemTemplate: t('directory.reasonsForThem'),
            notVisibleNote: t('directory.notVisibleNote'),
            cancel: t('common.cancel'),
            errorNetwork: t('common.errorNetwork'),
            errorGeneric: t('common.errorGeneric'),
          }}
        />
      </div>
    </div>
  );
}

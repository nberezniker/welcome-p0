import type { Metadata } from 'next';
import { getSql } from '../../../lib/db';
import { requireAccountId } from '../../../lib/session-page';
import { getT } from '../../../i18n';
import { MembershipEditor, type MembershipItem } from './membership-editor';

export const metadata: Metadata = { title: 'Мои события', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function MyEventsPage() {
  const accountId = await requireAccountId('/me/events');
  const { t } = await getT();
  const sql = getSql();

  const rows = await sql<{
    membership_id: string;
    event_id: string;
    event_slug: string;
    event_name: string;
    event_mode: string;
    state: string;
    directory_visible: boolean;
    matching_enabled: boolean;
    offer_tags: string[];
    need_tags: string[];
  }[]>`
    SELECT m.id AS membership_id, e.id AS event_id, e.slug AS event_slug, e.name AS event_name,
           COALESCE(e.mode, 'offline') AS event_mode, m.state, m.directory_visible, m.matching_enabled,
           m.offer_tags, m.need_tags
    FROM event_memberships m
    JOIN profiles p ON p.id = m.profile_id
    JOIN events e ON e.id = m.event_id
    WHERE p.account_id = ${accountId}
    ORDER BY m.created_at DESC
    LIMIT 100`;

  const items: MembershipItem[] = rows.map((r) => ({
    membershipId: r.membership_id,
    eventId: r.event_id,
    eventSlug: r.event_slug,
    eventName: r.event_name,
    eventMode: r.event_mode,
    state: r.state,
    directoryVisible: r.directory_visible,
    matchingEnabled: r.matching_enabled,
    offerTags: r.offer_tags,
    needTags: r.need_tags,
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{t('events.myTitle')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('events.mySubtitle')}</p>
      <div className="mt-6 flex flex-col gap-4">
        {items.length === 0 ? <p className="text-sm text-muted">{t('events.empty')}</p> : null}
        {items.map((item) => (
          <MembershipEditor
            key={item.membershipId}
            membership={item}
            strings={{
              openEvent: t('events.openEvent'),
              openDirectory: t('events.openDirectory'),
              leftBadge: t('events.leftBadge'),
              leave: t('events.leave'),
              leaveConfirm: t('events.leaveConfirm'),
              leftToast: t('events.leftToast'),
              intentTitle: t('events.intentTitle'),
              offerTagsLabel: t('events.offerTagsLabel'),
              needTagsLabel: t('events.needTagsLabel'),
              directoryVisible: t('events.directoryVisible'),
              directoryVisibleHint: t('events.directoryVisibleHint'),
              matchingEnabled: t('events.matchingEnabled'),
              matchingEnabledHint: t('events.matchingEnabledHint'),
              savedToast: t('events.savedToast'),
              save: t('common.save'),
              saving: t('common.saving'),
              tagPlaceholder: t('profile.tagPlaceholder'),
              errorNetwork: t('common.errorNetwork'),
              errorGeneric: t('common.errorGeneric'),
            }}
          />
        ))}
      </div>
    </div>
  );
}

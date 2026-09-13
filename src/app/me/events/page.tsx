import type { Metadata } from 'next';
import { getSql } from '../../../lib/db';
import { requireAccountId } from '../../../lib/session-page';
import { getT } from '../../../i18n';
import { taxonomyPayload } from '../../../domain/taxonomy';
import { parseCatalog } from '../../../domain/picker';
import { MembershipEditor, type MembershipItem } from './membership-editor';

export const metadata: Metadata = { title: 'Мои события', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function MyEventsPage() {
  const accountId = await requireAccountId('/me/events');
  const { locale, t } = await getT();
  const sql = getSql();
  // Same local catalogue the pickers use — limits never get duplicated in the UI.
  const catalog = parseCatalog(taxonomyPayload());
  if (!catalog) throw new Error('taxonomy catalogue payload is unusable');

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
    need_intents: string[];
    offer_intents: string[];
    interests: string[];
    industry: string | null;
    job_function: string | null;
    keywords: string[];
  }[]>`
    SELECT m.id AS membership_id, e.id AS event_id, e.slug AS event_slug, e.name AS event_name,
           COALESCE(e.mode, 'offline') AS event_mode, m.state, m.directory_visible, m.matching_enabled,
           m.offer_tags, m.need_tags,
           m.need_intents, m.offer_intents, m.interests, m.industry, m.job_function, m.keywords
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
    needIntents: r.need_intents,
    offerIntents: r.offer_intents,
    interests: r.interests,
    industry: r.industry,
    jobFunction: r.job_function,
    keywords: r.keywords,
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
            catalog={catalog}
            locale={locale}
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
              overrideTitle: t('member.overrideTitle'),
              overrideHint: t('member.overrideHint'),
              inheritHint: t('pick.inheritHint'),
              overrideNeed: t('member.overrideNeed'),
              overrideOffer: t('member.overrideOffer'),
              overrideInterests: t('member.overrideInterests'),
              overrideFunction: t('member.overrideFunction'),
              overrideIndustry: t('member.overrideIndustry'),
              overrideKeywords: t('member.overrideKeywords'),
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
                needHint: t('pick.needHint'),
                offerHint: t('pick.offerHint'),
                interestsHint: t('pick.interestsHint'),
                keywordsHint: t('pick.keywordsHint'),
                functionHint: t('pick.functionHint'),
                industryHint: t('pick.industryHint'),
              },
            }}
          />
        ))}
      </div>
    </div>
  );
}

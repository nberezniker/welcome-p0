import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '../../../../../lib/db';
import { requireAccountId } from '../../../../../lib/session-page';
import { getT } from '../../../../../i18n';
import { DirectoryPanel } from './directory-panel';
import { filtersFromQuery } from '../../../../../domain/directory-filters';
import { isUuid } from '../../../../../domain/organizer';
import type { ReasonTemplates } from '../../../../../domain/reasons';
import type { ReasonV4Templates } from '../../../../../domain/reasons-v4';

export const metadata: Metadata = { title: 'Каталог', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function EventDirectoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { eventId } = await params;
  const accountId = await requireAccountId(`/me/events/${eventId}/directory`);
  const { locale, t } = await getT();
  // Filter state lives in the URL; the server seeds the client panel from it so
  // a shared link opens the same narrowed view.
  const rawSearch = await searchParams;
  const single = (key: string): string | undefined => {
    const value = rawSearch[key];
    return typeof value === 'string' ? value : undefined;
  };
  const initialFilters = filtersFromQuery({
    mode: single('mode'),
    interest: single('interest'),
    function: single('function'),
    industry: single('industry'),
    q: single('q'),
  });
  // Reason sentences are built from i18n here; the API only returns codes.
  const reasonTemplates: ReasonTemplates = {
    me: {
      intent_need_covered: t('reason.me.intent_need_covered'),
      intent_offer_match: t('reason.me.intent_offer_match'),
      shared_interests: t('reason.me.shared_interests'),
      shared_function: t('reason.me.shared_function'),
      same_industry: t('reason.me.same_industry'),
      shared_tag: t('reason.me.shared_tag'),
    },
    them: {
      intent_need_covered: t('reason.them.intent_need_covered'),
      intent_offer_match: t('reason.them.intent_offer_match'),
      shared_interests: t('reason.them.shared_interests'),
      shared_function: t('reason.them.shared_function'),
      same_industry: t('reason.them.same_industry'),
      shared_tag: t('reason.them.shared_tag'),
    },
  };
  // v4 two-line templates («Польза» / «Развитие») — same rule as the v3 pair:
  // the API returns codes, the page builds the sentences.
  const reasonTemplatesV4: ReasonV4Templates = {
    useful: {
      goal_advanced: t('reason4.useful.goal_advanced'),
      need_covered: t('reason4.useful.need_covered'),
      mutual_needs: t('reason4.useful.mutual_needs'),
      shared_interests: t('reason4.useful.shared_interests'),
      complementary_functions: t('reason4.useful.complementary_functions'),
      same_context: t('reason4.useful.same_context'),
      peer_context: t('reason4.useful.peer_context'),
    },
    growth: {
      can_teach: t('reason4.growth.can_teach'),
      wants_your_help: t('reason4.growth.wants_your_help'),
      outside_circle: t('reason4.growth.outside_circle'),
      different_context: t('reason4.growth.different_context'),
    },
  };
  const sql = getSql();

  // The event must exist; directory access itself is enforced by the API.
  //
  // The `id` branch is taken only for a real UUID. `id = $1` against a slug
  // makes Postgres cast the literal to uuid, which is not a failing lookup but a
  // `PostgresError: invalid input syntax for type uuid` — the whole page then
  // threw and rendered the segment error surface, so this page's documented
  // slug support (`OR slug = $1`, and the API route accepts both) was a 500 in
  // practice. Same guard as src/app/api/events/[eventIdOrSlug]/directory/route.ts.
  const eventRows = isUuid(eventId)
    ? await sql<{ id: string; name: string; slug: string }[]>`
        SELECT id, name, slug FROM events WHERE id = ${eventId}::uuid LIMIT 1`
    : await sql<{ id: string; name: string; slug: string }[]>`
        SELECT id, name, slug FROM events WHERE slug = ${eventId} LIMIT 1`;
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
          initialFilters={initialFilters}
          locale={locale}
          reasonTemplates={reasonTemplates}
          reasonTemplatesV4={reasonTemplatesV4}
          kindLabels={{
            // Revealable contact kinds include phone (no card link for it).
            whatsapp: t('contacts.kind.whatsapp'),
            telegram_username: t('contacts.kind.telegram_username'),
            linkedin_url: t('contacts.kind.linkedin_url'),
            github_url: t('contacts.kind.github_url'),
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
            recModes: {
              useful: t('directory.recModes.useful'),
              grow: t('directory.recModes.grow'),
              similar: t('directory.recModes.similar'),
              explore: t('directory.recModes.explore'),
            },
            recExcluded: {
              no_candidates: t('directory.recExcluded.no_candidates'),
              gate_not_met: t('directory.recExcluded.gate_not_met'),
              no_shared_topic: t('directory.recExcluded.no_shared_topic'),
            },
            recUsefulLabel: t('reason4.usefulLabel'),
            recGrowthLabel: t('reason4.growthLabel'),
            scoreTemplate: t('directory.score'),
            notVisibleNote: t('directory.notVisibleNote'),
            cancel: t('common.cancel'),
            errorNetwork: t('common.errorNetwork'),
            errorGeneric: t('common.errorGeneric'),
            modes: {
              intent: t('dir.modeIntent'),
              interest: t('dir.modeInterest'),
              all: t('dir.modeAll'),
            },
            modeHints: {
              intent: t('dir.modeHintIntent'),
              interest: t('dir.modeHintInterest'),
              all: t('dir.modeHintAll'),
            },
            filterInterest: t('dir.filterInterest'),
            filterFunction: t('dir.filterFunction'),
            filterIndustry: t('dir.filterIndustry'),
            searchLabel: t('dir.searchLabel'),
            searchPlaceholder: t('dir.searchPlaceholder'),
            clearFilters: t('dir.clearFilters'),
            resultCount: t('dir.resultCount'),
            looksFor: t('dir.looksFor'),
            canOffer: t('dir.canOffer'),
            unspecified: t('pick.unspecified'),
          }}
        />
      </div>
    </div>
  );
}

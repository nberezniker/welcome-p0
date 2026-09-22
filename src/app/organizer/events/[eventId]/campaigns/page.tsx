import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '../../../../../lib/db';
import { requireAccountId } from '../../../../../lib/session-page';
import { getT } from '../../../../../i18n';
import { requireEventRole } from '../../../../../domain/organizer';
import { normalizeAudienceFilter, type AudienceFilter } from '../../../../../domain/campaigns';
import { parseCatalog } from '../../../../../domain/picker';
import { taxonomyPayload } from '../../../../../domain/taxonomy';
import { ForbiddenPage } from '../../../../../components/forbidden';
import { CampaignCard } from './campaign-card';
import { CreateCampaignForm } from './create-campaign-form';

export const metadata: Metadata = { title: 'Рассылки', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function CampaignsPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const accountId = await requireAccountId(`/organizer/events/${eventId}/campaigns`);
  const { locale, t } = await getT();
  const sql = getSql();

  // Campaigns are owner/admin territory (staff sees 403; server enforces anyway).
  const role = await requireEventRole(sql, accountId, eventId, ['owner', 'admin']);
  if (!role) return <ForbiddenPage locale={locale} />;

  const [eventRows, campaignRows] = await Promise.all([
    sql<{ id: string; name: string; slug: string }[]>`SELECT id, name, slug FROM events WHERE id = ${role.eventId} LIMIT 1`,
    sql<{ id: string; purpose: 'organizer_marketing' | 'service_channel'; state: 'draft' | 'approved' | 'running' | 'completed' | 'cancelled'; content_revision: number; approved_revision: number | null; body_text: string | null; audience_filter: Record<string, unknown> }[]>`
      SELECT id, purpose, state, content_revision, approved_revision, body_text, audience_filter
      FROM campaigns WHERE event_id = ${role.eventId}
      ORDER BY created_at DESC LIMIT 50`,
  ]);
  const event = eventRows[0];
  if (!event) notFound();
  const isOwner = role.role === 'owner';

  // The taxonomy catalogue is a local module (same source the pickers read), so
  // the segment UI is rendered server-side without a client round-trip.
  const catalog = parseCatalog(taxonomyPayload());
  if (!catalog) throw new Error('taxonomy catalogue payload is unusable');
  const maxOf = (axis: keyof typeof catalog.limits) => String(catalog.limits[axis]);

  const segmentStrings = {
    title: t('camp.segmentTitle'),
    hint: t('camp.segmentHint'),
    needs: t('camp.segmentNeeds'),
    offers: t('camp.segmentOffers'),
    interests: t('camp.segmentInterests'),
    function: t('camp.segmentFunction'),
    industry: t('camp.segmentIndustry'),
    none: t('camp.segmentNone'),
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
    needHint: t('camp.segmentAxisHint', { max: maxOf('need_intents') }),
    offerHint: t('camp.segmentAxisHint', { max: maxOf('offer_intents') }),
    interestsHint: t('camp.segmentAxisHint', { max: maxOf('interests') }),
    functionHint: t('pick.functionHint'),
    industryHint: t('pick.industryHint'),
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight">
          {t('camp.title')}: {event.name}
        </h1>
        <div className="flex gap-2">
          <Link href="/organizer" className="btn-light btn-small">
            {t('org.backToOrganizer')}
          </Link>
          <Link href={`/organizer/events/${event.id}`} className="btn-light btn-small">
            {t('org.overviewTitle')}
          </Link>
        </div>
      </div>
      <p className="mt-1.5 text-sm text-muted">{t('camp.subtitle')}</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <CreateCampaignForm
          eventId={event.id}
          purposeLabels={{
            organizer_marketing: t('camp.purpose.organizer_marketing'),
            service_channel: t('camp.purpose.service_channel'),
          }}
          strings={{
            createTitle: t('camp.createTitle'),
            purposeLabel: t('camp.purposeLabel'),
            bodyLabel: t('camp.bodyLabel'),
            bodyError: t('camp.bodyError'),
            createCta: t('camp.createCta'),
            saving: t('common.saving'),
            errorGeneric: t('common.errorGeneric'),
            errorNetwork: t('common.errorNetwork'),
          }}
        />

        <div className="flex flex-col gap-4">
          {campaignRows.length === 0 ? <p className="text-sm text-muted">{t('camp.empty')}</p> : null}
          {campaignRows.map((c) => (
            <CampaignCard
              key={c.id}
              campaign={{ ...c, audience_filter: normalizeAudienceFilter(c.audience_filter) as AudienceFilter }}
              isOwner={isOwner}
              catalog={catalog}
              locale={locale}
              strings={{
                purposeLabels: {
                  organizer_marketing: t('camp.purpose.organizer_marketing'),
                  service_channel: t('camp.purpose.service_channel'),
                },
                stateLabels: {
                  draft: t('camp.state.draft'),
                  approved: t('camp.state.approved'),
                  running: t('camp.state.running'),
                  completed: t('camp.state.completed'),
                  cancelled: t('camp.state.cancelled'),
                },
                revisionTemplate: t('camp.revision'),
                approvedRevisionTemplate: t('camp.approvedRevision'),
                edit: t('camp.edit'),
                editTitle: t('camp.editTitle'),
                editWarning: t('camp.editWarning'),
                bodyLabel: t('camp.bodyLabel'),
                bodyError: t('camp.bodyError'),
                save: t('common.save'),
                savedToast: t('common.saved'),
                cancel: t('common.cancel'),
                saving: t('common.saving'),
                audiencePreview: t('camp.audiencePreview'),
                audienceCountTemplate: t('camp.audienceCount'),
                audienceEmpty: t('camp.audienceEmpty'),
                audienceNote: t('camp.audienceNote'),
                segment: segmentStrings,
                segmentPreview: t('camp.segmentPreview'),
                segmentCountTemplate: t('camp.segmentCount'),
                approve: t('camp.approve'),
                approvedTemplate: t('camp.approved'),
                send: t('camp.send'),
                sendTitle: t('camp.sendTitle'),
                sendConfirmTemplate: t('camp.sendConfirmText'),
                sendCta: t('camp.sendCta'),
                sending: t('camp.sending'),
                sentTemplate: t('camp.sent'),
                cancelCampaign: t('camp.cancelCampaign'),
                cancelTitle: t('camp.cancelTitle'),
                cancelConfirmText: t('camp.cancelConfirmText'),
                cancelCta: t('camp.cancelCta'),
                cancelling: t('camp.cancelling'),
                cancelResultTemplate: t('camp.cancelResult'),
                cancelResultSentTemplate: t('camp.cancelResultSent'),
                cancelTooLate: t('camp.cancelTooLate'),
                statsTitle: t('camp.statsTitle'),
                statsLabels: {
                  pending: t('camp.stats.pending'),
                  leased: t('camp.stats.leased'),
                  sent: t('camp.stats.sent'),
                  delivered: t('camp.stats.delivered'),
                  failed: t('camp.stats.failed'),
                  unknown: t('camp.stats.unknown'),
                  suppressed: t('camp.stats.suppressed'),
                  cancelled: t('camp.stats.cancelled'),
                },
                statsNote: t('camp.statsNote'),
                refresh: t('camp.refresh'),
                errorGeneric: t('common.errorGeneric'),
                errorNetwork: t('common.errorNetwork'),
                mfaTitle: t('mfa.stepUpTitle'),
                mfaText: t('mfa.stepUpText'),
                mfaCodeLabel: t('mfa.stepUpCode'),
                mfaCta: t('mfa.stepUpCta'),
                mfaVerifying: t('mfa.stepUpVerifying'),
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

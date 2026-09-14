import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '../../../../lib/db';
import { requireAccountId } from '../../../../lib/session-page';
import { getT } from '../../../../i18n';
import { requireEventRole } from '../../../../domain/organizer';
import { loadEventAnalytics } from '../../../../domain/event-analytics';
import { ForbiddenPage } from '../../../../components/forbidden';
import { InviteButton } from './invite-button';
import { ImportPanel } from './import-panel';
import { SettingsPanel } from './settings-panel';
import { FunnelPanel } from './funnel-panel';

export const metadata: Metadata = { title: 'Обзор события', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function OrganizerEventPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const accountId = await requireAccountId(`/organizer/events/${eventId}`);
  const { locale, t } = await getT();
  const sql = getSql();

  const role = await requireEventRole(sql, accountId, eventId, ['owner', 'admin', 'staff']);
  if (!role) return <ForbiddenPage locale={locale} />;

  const [eventRows, analytics, regRows] = await Promise.all([
    sql<{ id: string; slug: string; name: string; access_mode: string; join_code: string | null; timezone: string; directory_close_at: Date | null }[]>`
      SELECT id, slug, name, access_mode, join_code, timezone, directory_close_at
      FROM events WHERE id = ${role.eventId} LIMIT 1`,
    loadEventAnalytics(sql, role.eventId),
    sql<{ id: string; imported_name: string | null; approval_status: string; claim_state: string }[]>`
      SELECT id, imported_name, approval_status, claim_state
      FROM registrations WHERE event_id = ${role.eventId}
      ORDER BY created_at ASC LIMIT 200`,
  ]);
  const event = eventRows[0];
  if (!event) notFound();

  const canManage = role.role === 'owner' || role.role === 'admin';

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-extrabold tracking-tight">
          {t('org.overviewTitle')}: {event.name}
        </h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/organizer" className="btn-light btn-small">
            {t('org.backToOrganizer')}
          </Link>
          <Link href={`/e/${event.slug}`} className="btn-light btn-small">
            {t('org.eventLink')}
          </Link>
          {canManage ? (
            <Link href={`/organizer/events/${event.id}/campaigns`} className="btn-light btn-small">
              {t('org.campaignsLink')}
            </Link>
          ) : null}
        </div>
      </div>
      <p className="mt-1 text-xs uppercase tracking-wide text-muted">
        {t('org.organizerHeading', { name: role.role })} · {event.timezone}
      </p>

      {/* Funnel aggregates (shared with GET /api/organizer/events/[eventId]/analytics) */}
      <FunnelPanel
        analytics={analytics}
        strings={{
          title: t('org.statsTitle'),
          steps: {
            registrations: t('org.stats.registrations'),
            activated: t('org.stats.activated'),
            directory: t('org.stats.directory'),
            intros: t('org.stats.requested'),
            mutual: t('org.stats.mutual'),
          },
          conversion: t('org.funnel.conversion'),
          claimed: t('org.funnel.claimed'),
          declined: t('org.funnel.declined'),
          reveals: t('org.funnel.reveals'),
          notes: t('org.funnel.notes'),
          attendance: t('org.funnel.attendance'),
          outcomesTitle: t('org.funnel.outcomesTitle'),
          byDayTitle: t('org.funnel.byDayTitle'),
          legendRegistrations: t('org.funnel.legendRegistrations'),
          legendIntros: t('org.funnel.legendIntros'),
          legendMutual: t('org.funnel.legendMutual'),
          chartAlt: t('org.funnel.chartAlt'),
          noData: t('org.funnel.noData'),
          hint: t('org.statsHint'),
        }}
      />

      {/* Registrations + claim links */}
      <section className="card mt-6" aria-labelledby="regs-heading">
        <h2 id="regs-heading" className="text-lg font-bold tracking-tight">
          {t('org.registrationsTitle')}
        </h2>
        {regRows.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t('org.registrationsEmpty')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="border-b border-line px-2 py-1.5">{t('org.regName')}</th>
                  <th className="border-b border-line px-2 py-1.5">{t('org.regStatus')}</th>
                  <th className="border-b border-line px-2 py-1.5">{t('org.regClaim')}</th>
                  <th className="border-b border-line px-2 py-1.5">{t('org.invite')}</th>
                </tr>
              </thead>
              <tbody>
                {regRows.map((r) => (
                  <tr key={r.id} data-testid={`reg-${r.id}`}>
                    <td className="border-b border-line px-2 py-1.5">{r.imported_name ?? '—'}</td>
                    <td className="border-b border-line px-2 py-1.5">{r.approval_status}</td>
                    <td className="border-b border-line px-2 py-1.5">{r.claim_state}</td>
                    <td className="border-b border-line px-2 py-1.5">
                      {canManage ? (
                        <InviteButton
                          eventId={event.id}
                          registrationId={r.id}
                          strings={{
                            invite: t('org.invite'),
                            invited: t('org.invited'),
                            inviteTitleTemplate: t('org.inviteTitle'),
                            inviteHint: t('org.inviteHint'),
                            claimUrlLabel: t('org.claimUrlLabel'),
                            claimCopied: t('org.claimCopied'),
                            copyLabel: t('common.copy'),
                            claimAlready: t('org.claimAlready'),
                            claimNotAllowed: t('org.claimNotAllowed'),
                            errorGeneric: t('common.errorGeneric'),
                            errorNetwork: t('common.errorNetwork'),
                          }}
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canManage ? (
        <>
          <ImportPanel
            eventId={event.id}
            strings={{
              importTitle: t('org.importTitle'),
              importHint: t('org.importHint'),
              importFile: t('org.importFile'),
              importPreview: t('org.importPreview'),
              importCommit: t('org.importCommit'),
              importing: t('common.saving'),
              previewTitle: t('org.previewTitle'),
              previewTotalTemplate: t('org.previewTotal'),
              previewValidTemplate: t('org.previewValid'),
              previewInvalidTemplate: t('org.previewInvalid'),
              previewQuarantinedTemplate: t('org.previewQuarantined'),
              previewDuplicatesTemplate: t('org.previewDuplicates'),
              commitCountsTemplate: t('org.commitCounts'),
              importErrors: t('org.importErrors'),
              errorGeneric: t('common.errorGeneric'),
              errorNetwork: t('common.errorNetwork'),
              importMapTitle: t('org.importMapTitle'),
              importMapHint: t('org.importMapHint'),
              importMapColumn: t('org.importMapColumn'),
              importMapField: t('org.importMapField'),
              importMapIgnore: t('org.importMapIgnore'),
              importMapRecalc: t('org.importMapRecalc'),
              importWouldInsertTemplate: t('org.importWouldInsert'),
              importWouldUpdateTemplate: t('org.importWouldUpdate'),
              importWouldQuarantineTemplate: t('org.importWouldQuarantine'),
              importFieldLabels: {
                name: t('org.importField.name'),
                email: t('org.importField.email'),
                company: t('org.importField.company'),
                role: t('org.importField.role'),
                external_id: t('org.importField.external_id'),
                approval_status: t('org.importField.approval_status'),
              },
              importMapErrorUnknownField: t('org.importMapErrorUnknownField'),
              importMapErrorUnknownColumn: t('org.importMapErrorUnknownColumn'),
              importMapErrorDuplicate: t('org.importMapErrorDuplicate'),
              importMapErrorInvalid: t('org.importMapErrorInvalid'),
            }}
          />
          <SettingsPanel
            eventId={event.id}
            initialAccessMode={event.access_mode ?? 'public'}
            initialJoinCodeSet={event.join_code !== null}
            initialDirectoryCloseAt={
              event.directory_close_at ? new Date(event.directory_close_at).toISOString().slice(0, 16) : null
            }
            strings={{
              settingsTitle: t('org.settingsTitle'),
              accessModeSetting: t('org.accessModeSetting'),
              joinCodeLabel: t('org.joinCodeLabel'),
              joinCodeSet: t('org.joinCodeSet'),
              joinCodeClear: t('org.joinCodeClear'),
              directoryCloseLabel: t('org.directoryCloseLabel'),
              settingsSaved: t('org.settingsSaved'),
              save: t('common.save'),
              saving: t('common.saving'),
              errorGeneric: t('common.errorGeneric'),
              errorNetwork: t('common.errorNetwork'),
            }}
          />
        </>
      ) : null}
    </div>
  );
}

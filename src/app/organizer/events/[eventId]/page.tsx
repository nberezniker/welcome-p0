import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '../../../../lib/db';
import { requireAccountId } from '../../../../lib/session-page';
import { getT } from '../../../../i18n';
import { requireEventRole } from '../../../../domain/organizer';
import { ForbiddenPage } from '../../../../components/forbidden';
import { InviteButton } from './invite-button';
import { ImportPanel } from './import-panel';
import { SettingsPanel } from './settings-panel';

export const metadata: Metadata = { title: 'Обзор события', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

interface Funnel {
  registrations: number;
  activated: number;
  directoryOptIn: number;
  requested: number;
  mutual: number;
  selfReports: number;
}

async function loadFunnel(sql: ReturnType<typeof getSql>, eventId: string): Promise<Funnel> {
  const [regRows, memberRows, dirRows, introRows, mutualRows, presentRows] = await Promise.all([
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM registrations WHERE event_id = ${eventId}`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM event_memberships WHERE event_id = ${eventId} AND state = 'active'`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM event_memberships WHERE event_id = ${eventId} AND state = 'active' AND directory_visible = true`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM introductions WHERE event_id = ${eventId}`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM introductions WHERE event_id = ${eventId} AND state = 'mutual'`,
    sql<{ count: number }[]>`SELECT count(*)::int AS count FROM event_memberships WHERE event_id = ${eventId} AND attendance_source = 'self'`,
  ]);
  return {
    registrations: regRows[0]?.count ?? 0,
    activated: memberRows[0]?.count ?? 0,
    directoryOptIn: dirRows[0]?.count ?? 0,
    requested: introRows[0]?.count ?? 0,
    mutual: mutualRows[0]?.count ?? 0,
    selfReports: presentRows[0]?.count ?? 0,
  };
}

export default async function OrganizerEventPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const accountId = await requireAccountId(`/organizer/events/${eventId}`);
  const { locale, t } = await getT();
  const sql = getSql();

  const role = await requireEventRole(sql, accountId, eventId, ['owner', 'admin', 'staff']);
  if (!role) return <ForbiddenPage locale={locale} />;

  const [eventRows, funnel, regRows] = await Promise.all([
    sql<{ id: string; slug: string; name: string; access_mode: string; join_code: string | null; timezone: string; directory_close_at: Date | null }[]>`
      SELECT id, slug, name, access_mode, join_code, timezone, directory_close_at
      FROM events WHERE id = ${role.eventId} LIMIT 1`,
    loadFunnel(sql, role.eventId),
    sql<{ id: string; imported_name: string | null; approval_status: string; claim_state: string }[]>`
      SELECT id, imported_name, approval_status, claim_state
      FROM registrations WHERE event_id = ${role.eventId}
      ORDER BY created_at ASC LIMIT 200`,
  ]);
  const event = eventRows[0];
  if (!event) notFound();

  const canManage = role.role === 'owner' || role.role === 'admin';
  const funnelItems = [
    { label: t('org.stats.registrations'), value: funnel.registrations },
    { label: t('org.stats.activated'), value: funnel.activated },
    { label: t('org.stats.directory'), value: funnel.directoryOptIn },
    { label: t('org.stats.requested'), value: funnel.requested },
    { label: t('org.stats.mutual'), value: funnel.mutual },
    { label: t('org.stats.useful'), value: null as number | null },
  ];

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

      {/* Funnel aggregates */}
      <section className="card mt-6" aria-labelledby="funnel-heading">
        <h2 id="funnel-heading" className="eyebrow">
          {t('org.statsTitle')}
        </h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="funnel">
          {funnelItems.map((item) => (
            <div key={item.label} className="rounded-xl border border-line bg-paper px-3 py-2.5">
              <b className="block text-2xl leading-tight tabular-nums">{item.value ?? '—'}</b>
              <span className="text-[11px] text-muted">{item.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">{t('org.statsHint')}</p>
      </section>

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
                          regName={r.imported_name ?? ''}
                          strings={{
                            invite: t('org.invite'),
                            invited: t('org.invited'),
                            inviteTitle: (name) => t('org.inviteTitle', { name }),
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
              previewTotal: (n) => t('org.previewTotal', { n }),
              previewValid: (n) => t('org.previewValid', { n }),
              previewInvalid: (n) => t('org.previewInvalid', { n }),
              previewQuarantined: (n) => t('org.previewQuarantined', { n }),
              previewDuplicates: (n) => t('org.previewDuplicates', { n }),
              commitCounts: (c) =>
                t('org.commitCounts', {
                  created: c.created,
                  updated: c.updated,
                  skipped: c.skipped,
                  quarantined: c.quarantined,
                }),
              importErrors: t('org.importErrors'),
              errorGeneric: t('common.errorGeneric'),
              errorNetwork: t('common.errorNetwork'),
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

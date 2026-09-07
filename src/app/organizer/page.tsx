import type { Metadata } from 'next';
import Link from 'next/link';
import { getSql } from '../../lib/db';
import { requireAccountId } from '../../lib/session-page';
import { getT } from '../../i18n';
import { CreateEventForm } from './create-event-form';

export const metadata: Metadata = { title: 'Организатор', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function OrganizerIndexPage() {
  const accountId = await requireAccountId('/organizer');
  const { t } = await getT();
  const sql = getSql();

  const rows = await sql<{
    event_id: string;
    slug: string;
    name: string;
    mode: string;
    access_mode: string;
    status: string;
    timezone: string;
    starts_at: Date | null;
    role: string;
  }[]>`
    SELECT e.id AS event_id, e.slug, e.name, COALESCE(e.mode, 'offline') AS mode, e.access_mode, e.status, e.timezone, e.starts_at, om.role
    FROM organizer_members om
    JOIN events e ON e.organizer_id = om.organizer_id
    WHERE om.account_id = ${accountId}
    ORDER BY e.created_at DESC
    LIMIT 50`;

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{t('org.title')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('org.subtitle')}</p>

      <section aria-labelledby="my-events-heading" className="mt-6">
        <h2 id="my-events-heading" className="text-lg font-bold tracking-tight">
          {t('events.myTitle')}
        </h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-muted">{t('org.empty')}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {rows.map((r) => (
              <li key={r.event_id} className="card-tight flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold">
                    <Link href={`/organizer/events/${r.event_id}`} className="underline-offset-2 hover:underline">
                      {r.name}
                    </Link>
                  </h3>
                  <p className="text-xs text-muted">
                    {r.role} · {r.mode} · {r.access_mode} · {r.timezone}
                    {r.starts_at ? ` · ${new Date(r.starts_at).toLocaleDateString()}` : ''}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link href={`/organizer/events/${r.event_id}`} className="btn-light btn-small">
                    {t('org.overviewTitle')}
                  </Link>
                  <Link href={`/organizer/events/${r.event_id}/campaigns`} className="btn-light btn-small">
                    {t('org.campaignsLink')}
                  </Link>
                  <Link href={`/e/${r.slug}`} className="btn-light btn-small">
                    {t('org.eventLink')}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-8">
        <CreateEventForm
          modeLabels={{
            offline: t('event.mode.offline'),
            online: t('event.mode.online'),
            hybrid: t('event.mode.hybrid'),
          }}
          strings={{
            createTitle: t('org.createTitle'),
            nameLabel: t('org.nameLabel'),
            nameError: t('org.nameError'),
            modeLabel: t('org.modeLabel'),
            accessModeLabel: t('org.accessModeLabel'),
            timezoneLabel: t('org.timezoneLabel'),
            startsLabel: t('org.startsLabel'),
            endsLabel: t('org.endsLabel'),
            locationLabel: t('org.locationLabel'),
            onlineLinkLabel: t('org.onlineLinkLabel'),
            descriptionLabel: t('org.descriptionLabel'),
            consentTextLabel: t('org.consentTextLabel'),
            slugLabel: t('org.slugLabel'),
            slugHint: t('org.slugHint'),
            createCta: t('org.createCta'),
            creating: t('org.creating'),
            created: t('org.created'),
            errorGeneric: t('common.errorGeneric'),
            errorNetwork: t('common.errorNetwork'),
          }}
        />
      </div>
    </div>
  );
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getSql } from '../../../lib/db';
import { getT, POLICY_VERSION, type Locale } from '../../../i18n';
import { loadEventView } from '../../../lib/event-view';
import { getOptionalAccountId } from '../../../lib/session-page';
import JoinEventButton from './join-button';
import EventMemberPanel from './member-panel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Событие',
  robots: { index: false, follow: false },
};

const DATE_LOCALES: Record<Locale, string> = { en: 'en-GB', ru: 'ru-RU', es: 'es-ES' };

function formatInTz(date: Date, timezone: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(DATE_LOCALES[locale], {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Event landing (locale-aware): public info, join (code-aware), member panel
 * with attendance self-report + per-event consent toggles. Online link shown
 * only to members; anonymous visitors never see member data. */
export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { locale, t } = await getT();
  const accountId = await getOptionalAccountId();
  const sql = getSql();

  const view = await loadEventView(sql, slug, accountId);
  if (!view) notFound();

  const { event, viewer } = view;
  const needsCode = event.access_mode === 'closed' || event.access_mode === 'registration';
  const canJoin = event.status === 'active' && !viewer.is_member;
  // Member state for the participation panel.
  let membership: { id: string; directory_visible: boolean; attendance_source: string } | null = null;
  let marketingConsent = false;
  if (viewer.is_member && accountId) {
    const membershipRows = await sql<{ id: string; directory_visible: boolean; attendance_source: string }[]>`
      SELECT id, directory_visible, attendance_source
      FROM event_memberships m JOIN profiles p ON p.id = m.profile_id
      WHERE m.event_id = ${event.id} AND p.account_id = ${accountId} AND m.state = 'active'
      LIMIT 1`;
    membership = membershipRows[0] ?? null;
    const consentRows = await sql<{ action: string }[]>`
      SELECT action FROM consent_events
      WHERE account_id = ${accountId} AND purpose = 'organizer_marketing'
        AND scope_type = 'event' AND scope_id = ${event.id}
      ORDER BY created_at DESC LIMIT 1`;
    marketingConsent = consentRows[0]?.action === 'grant';
  }

  const modeLabel = event.mode === 'online' ? 'event.mode.online' : event.mode === 'hybrid' ? 'event.mode.hybrid' : 'event.mode.offline';
  const accessLabel =
    event.access_mode === 'public'
      ? 'event.access.public'
      : event.access_mode === 'registration'
        ? 'event.access.registration'
        : 'event.access.closed';

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-6">
      <p className="text-xs font-bold uppercase tracking-wide text-muted">{t('landing.organizerEyebrow')}</p>
      <div className="card mt-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="chip">{t(modeLabel)}</span>
          <span className="chip !bg-paper !text-muted">{t(accessLabel)}</span>
        </div>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight">{event.name}</h1>

        <dl className="mt-4 flex flex-col gap-1 text-sm text-muted">
          {event.starts_at && (
            <div>
              <dt className="inline font-semibold text-ink">{t('event.timeTitle')}: </dt>
              <dd className="inline">
                {formatInTz(new Date(event.starts_at), event.timezone, locale)}
                {event.ends_at ? ` — ${formatInTz(new Date(event.ends_at), event.timezone, locale)}` : ''}
              </dd>
            </div>
          )}
          <div>
            <dt className="inline font-semibold text-ink">{t('org.timezoneLabel')}: </dt>
            <dd className="inline">{event.timezone}</dd>
          </div>
          {event.location_label && (
            <div>
              <dt className="inline font-semibold text-ink">{t('event.locationTitle')}: </dt>
              <dd className="inline">{event.location_label}</dd>
            </div>
          )}
        </dl>

        {event.description && <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-ink">{event.description}</p>}

        {event.consent_text && (
          <div className="mt-4 rounded-xl bg-paper px-4 py-3 text-xs text-muted">
            <p className="font-bold uppercase tracking-wide">{t('event.consentTextTitle')}</p>
            <p className="mt-1 whitespace-pre-line">{event.consent_text}</p>
          </div>
        )}

        {viewer.online_link && (
          <a
            href={viewer.online_link}
            rel="noopener noreferrer nofollow"
            className="btn-light btn-small mt-4"
            data-testid="online-room-link"
          >
            {t('event.onlineLink')} ↗
          </a>
        )}

        {!viewer.is_member && canJoin && (
          <div className="mt-6 border-t border-line pt-5">
            <JoinEventButton
              eventId={event.id}
              needsCode={needsCode}
              strings={{
                joinCta: t('event.joinCta'),
                joining: t('event.joining'),
                joinCodeLabel: t('event.joinCodeLabel'),
                joinCodeHint: t('event.joinCodeHint'),
                joinProfileRequired: t('event.joinProfileRequired'),
                joinFull: t('event.joinFull'),
                joinForbidden: t('event.joinForbidden'),
                joinNotActive: t('event.joinNotActive'),
                signInToJoin: t('common.errorUnauthorized'),
                errorGeneric: t('common.errorGeneric'),
                errorNetwork: t('common.errorNetwork'),
                joined: t('event.alreadyMember'),
              }}
            />
            <p className="mt-3 text-xs text-muted">{t('event.participantsNote')}</p>
          </div>
        )}

        {viewer.is_member && membership ? (
          <EventMemberPanel
            membershipId={membership.id}
            eventId={event.id}
            initialDirectoryVisible={membership.directory_visible}
            initialPresent={membership.attendance_source === 'self'}
            initialMarketingConsent={marketingConsent}
            isOnline={event.mode === 'online'}
            strings={{
              memberPanelTitle: t('event.memberPanelTitle'),
              attendanceToggle: t('event.attendanceToggle'),
              attendanceToggleOnline: t('event.attendanceToggleOnline'),
              attendanceHint: t('event.attendanceHint'),
              directoryConsentLine: t('event.directoryConsentLine'),
              marketingConsentLine: t('event.marketingConsentLine'),
              consentSaved: t('event.consentSaved'),
              openDirectory: t('event.openDirectory'),
              myEventsLink: t('event.myEventsLink'),
              errorNetwork: t('common.errorNetwork'),
              errorGeneric: t('common.errorGeneric'),
            }}
          />
        ) : (
          !viewer.is_member &&
          needsCode && (
            <p className="mt-4 text-xs text-muted">{t('event.joinCodeHint')}</p>
          )
        )}
      </div>
    </main>
  );
}

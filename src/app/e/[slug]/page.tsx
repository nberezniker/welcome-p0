import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getSql } from '../../../lib/db';
import { getT } from '../../../i18n';
import { loadEventView } from '../../../lib/event-view';
import { getOptionalAccountId } from '../../../lib/session-page';
import { appBaseUrl } from '../../../lib/env';
import { formatEventSchedule } from '../../../lib/event-time';
import { googleCalendarUrl } from '../../../domain/ics';
import { ShareLinks } from '../../../components/share-links';
import JoinEventButton from './join-button';
import EventMemberPanel from './member-panel';
import { CalendarOptions } from './calendar-options';

export const dynamic = 'force-dynamic';

/**
 * Event metadata, mirroring the public card (/p/[slug]): the unfurled URL is the
 * canonical one on APP_BASE_URL and the OG tags carry the event's own name, so a
 * pasted link reads as the event instead of a generic title.
 *
 * The projection is loaded with NO viewer — metadata is consumed by crawlers and
 * chat clients, and the member-only room link must never be part of it.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { t } = await getT();
  const view = await loadEventView(getSql(), slug, null);
  // A missing event must not leak "this slug exists" through metadata.
  if (!view) return { title: t('event.notFound'), robots: { index: false, follow: false } };

  const event = view.event;
  const title = t('event.metaTitle', { name: event.name });
  // What the organizer wrote is already public on the page; the fallback keeps a
  // description-less event from unfurling as a bare title.
  const description = event.description?.trim() || t('event.metaDescription');
  const url = `${appBaseUrl().replace(/\/+$/, '')}/e/${event.slug}`;

  return {
    title,
    description,
    robots: { index: false, follow: false },
    alternates: { canonical: url },
    openGraph: { title, description, type: 'website', url },
  };
}

/** Event landing (locale-aware): public info, join (code-aware), member panel
 * with attendance self-report + per-event consent toggles. Online link shown
 * only to members; anonymous visitors never see member data.
 *
 * THE ORDER BELOW IS THE HIERARCHY, and it is asserted in
 * tests/e2e/event-actions.spec.ts: the title, then THE ACTION the page exists
 * for, then everything secondary. The audit that prompted this found eight
 * `btn` controls with `Join` last — a visitor scrolled past `Add to calendar`,
 * `Google Calendar` and five share controls to reach the only one that matters.
 * So: one schedule line, the join CTA (or, for a member, the member state),
 * ONE calendar control, ONE share control, and only then the prose. */
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
      SELECT m.id, m.directory_visible, m.attendance_source
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
  // The schedule with the zone named ONCE (src/lib/event-time.ts) — the page
  // used to print the zone twice, in the label and in a row of its own.
  const schedule = formatEventSchedule(
    event.starts_at ? new Date(event.starts_at) : null,
    event.ends_at ? new Date(event.ends_at) : null,
    event.timezone,
    locale,
  );
  const eventUrl = `${appBaseUrl().replace(/\/+$/, '')}/e/${event.slug}`;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-6">
      <p className="text-xs font-bold uppercase tracking-wide text-muted">{t('landing.forOrganizer.eyebrow')}</p>
      <div className="card mt-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="chip">{t(modeLabel)}</span>
          <span className="chip !bg-paper !text-muted">{t(accessLabel)}</span>
        </div>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight">{event.name}</h1>

        <dl className="mt-4 flex flex-col gap-1 text-sm text-muted">
          {schedule ? (
            <div>
              <dt className="inline font-semibold text-ink">{t('event.timeTitle')}: </dt>
              {/* The string carries its own zone (src/lib/event-time.ts), and the
                  testid is how the e2e reads the schedule it formats. */}
              <dd className="inline" data-testid="event-when">
                {schedule}
              </dd>
            </div>
          ) : (
            /* No start time at all: there is no clock for the zone to qualify,
               so it keeps a row of its own rather than riding on nothing. */
            <div>
              <dt className="inline font-semibold text-ink">{t('org.timezoneLabel')}: </dt>
              <dd className="inline">{event.timezone}</dd>
            </div>
          )}
          {event.location_label && (
            <div>
              <dt className="inline font-semibold text-ink">{t('event.locationTitle')}: </dt>
              <dd className="inline">{event.location_label}</dd>
            </div>
          )}
        </dl>

        {/* THE PRIMARY ACTION, first control on the page. A member has already
            done it, so the same slot names their state instead — the controls
            themselves stay in the participation panel below, where they were. */}
        {viewer.is_member ? (
          <p
            className="mt-5 rounded-xl bg-mint px-4 py-3 text-sm font-semibold text-pine"
            role="status"
            data-testid="member-state"
          >
            {t('event.alreadyMember')}
          </p>
        ) : canJoin ? (
          <div className="mt-5 border-t border-line pt-5">
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
        ) : null}

        {/* ONE calendar control: the .ics download adds the event and is a plain
            link, so it needs no JavaScript and the interop contract is untouched.
            The Google template is the secondary option INSIDE it, one disclosure
            away — not a second button beside it. Both exist only when there is a
            schedule: a calendar entry without a time is a lie. The room link is
            never part of either (src/domain/ics.ts). */}
        {event.starts_at ? (
          <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="event-calendar">
            <a
              href={`/api/events/${encodeURIComponent(event.slug)}/ics`}
              className="btn-light"
              data-testid="event-ics"
            >
              {t('event.addToCalendar')}
            </a>
            <CalendarOptions
              googleHref={googleCalendarUrl({
                name: event.name,
                description: event.description,
                locationLabel: event.location_label,
                startsAt: new Date(event.starts_at),
                endsAt: event.ends_at ? new Date(event.ends_at) : null,
              })}
              toggleLabel={t('event.calendarMore')}
              linkLabel={t('event.addToGoogleCalendar')}
            />
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted" data-testid="event-no-schedule">
            {t('event.calendarNoSchedule')}
          </p>
        )}

        {/* ONE share control, revealing the four deeplinks: the row of five used
            to compete with the action above it. */}
        <div className="mt-3">
          <ShareLinks
            url={eventUrl}
            title={event.name}
            testId="event-share"
            disclosure={{ label: t('share.label') }}
            labels={{
              linkedin: t('share.linkedin'),
              whatsapp: t('share.whatsapp'),
              telegram: t('share.telegram'),
              x: t('share.x'),
            }}
            shareLabel={t('share.native')}
            copiedLabel={t('share.copied')}
          />
        </div>

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
            className="btn-light mt-4"
            data-testid="online-room-link"
          >
            {t('event.onlineLink')} ↗
          </a>
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

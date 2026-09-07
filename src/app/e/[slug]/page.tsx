import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getSql } from '../../../lib/db';
import { getAccountIdByToken, SESSION_COOKIE } from '../../../lib/auth';
import { loadEventView } from '../../../lib/event-view';
import JoinEventButton from './join-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Событие',
  robots: { index: false, follow: false },
};

function formatDateTime(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** Event landing: public info + join affordance. Online link is shown only to
 * active members (server-checked); anonymous visitors never see member data. */
export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value ?? null;
  const accountId = await getAccountIdByToken(token);

  const view = await loadEventView(getSql(), slug, accountId);
  if (!view) notFound();

  const { event, viewer } = view;
  const canJoin = event.status === 'active' && event.access_mode === 'public' && !viewer.is_member;

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-14">
      <article className="rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Событие</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{event.name}</h1>

        <dl className="mt-4 space-y-1 text-sm text-neutral-600">
          {event.starts_at && (
            <div>
              <dt className="inline text-neutral-500">Начало: </dt>
              <dd className="inline">{formatDateTime(new Date(event.starts_at), event.timezone)}</dd>
            </div>
          )}
          {event.ends_at && (
            <div>
              <dt className="inline text-neutral-500">Окончание: </dt>
              <dd className="inline">{formatDateTime(new Date(event.ends_at), event.timezone)}</dd>
            </div>
          )}
          {event.location_label && (
            <div>
              <dt className="inline text-neutral-500">Место: </dt>
              <dd className="inline">{event.location_label}</dd>
            </div>
          )}
          <div>
            <dt className="inline text-neutral-500">Часовой пояс: </dt>
            <dd className="inline">{event.timezone}</dd>
          </div>
        </dl>

        {event.description && <p className="mt-4 whitespace-pre-line text-neutral-700">{event.description}</p>}

        {event.consent_text && (
          <p className="mt-4 rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-600">{event.consent_text}</p>
        )}

        {viewer.is_member && (
          <p className="mt-6 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
            Вы участник этого события.
          </p>
        )}

        {viewer.online_link && (
          <a
            href={viewer.online_link}
            rel="noopener noreferrer nofollow"
            className="mt-4 inline-block rounded-xl border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50"
          >
            Ссылка на онлайн-комнату
          </a>
        )}

        {canJoin && <JoinEventButton eventId={event.id} />}

        {!viewer.is_member && event.access_mode !== 'public' && (
          <p className="mt-6 text-sm text-neutral-500">
            Участие — по приглашению организатора или ссылке из регистрации.
          </p>
        )}
      </article>
    </main>
  );
}

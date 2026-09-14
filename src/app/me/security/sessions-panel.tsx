'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal, Toast, useToast } from '../../../components/modal';

export interface SessionsStrings {
  title: string;
  subtitle: string;
  currentBadge: string;
  createdLabel: string;
  lastSeenLabel: string;
  revoke: string;
  revoking: string;
  revokeAll: string;
  revokeAllConfirmTitle: string;
  revokeAllConfirmBody: string;
  revokeConfirmTitle: string;
  revokeConfirmBody: string;
  confirm: string;
  cancel: string;
  empty: string;
  revokedToast: string;
  errorGeneric: string;
  errorNetwork: string;
}

interface ActiveSession {
  id: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

/** Dates render in the PAGE's locale (passed from the server), never from
 * `navigator`, so the server and client markup agree and hydration is stable. */
function formatMoment(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
  }
}

/**
 * "Active devices": the sessions attached to this account.
 *
 * One row per session with two timestamps and a revoke action. The current
 * session cannot be revoked from its own row — revoking it is offered as
 * "sign out everywhere" instead, because that is the only case where killing
 * the session you are holding makes sense. Revoking your own current session
 * (via that button) ends the session and sends you to /login.
 */
export function SessionsPanel({
  sessions,
  locale,
  strings,
}: {
  sessions: ActiveSession[];
  locale: string;
  strings: SessionsStrings;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ActiveSession | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revokeOne = async (session: ActiveSession): Promise<void> => {
    setBusy(session.id);
    setError(null);
    try {
      const res = await fetch(`/api/me/sessions/${session.id}`, { method: 'DELETE' });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { current_revoked?: boolean } | null;
        setRevokeTarget(null);
        // Killing the session you are holding means there is nothing left to
        // render: go to the sign-in page.
        if (body?.current_revoked) {
          router.replace('/login');
          router.refresh();
          return;
        }
        toast.show(strings.revokedToast);
        router.refresh();
      } else {
        setError(strings.errorGeneric);
      }
    } catch {
      setError(strings.errorNetwork);
    } finally {
      setBusy(null);
    }
  };

  const revokeAll = async (): Promise<void> => {
    setBusy('all');
    setError(null);
    try {
      const res = await fetch('/api/me/sessions', { method: 'DELETE' });
      if (res.ok) {
        setRevokeAllOpen(false);
        router.replace('/login');
        router.refresh();
        return;
      }
      setError(strings.errorGeneric);
    } catch {
      setError(strings.errorNetwork);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card" aria-labelledby="sessions-heading" data-testid="sessions-panel">
      <h2 id="sessions-heading" className="text-lg font-bold tracking-tight">
        {strings.title}
      </h2>
      <p className="mt-1 text-xs text-muted">{strings.subtitle}</p>

      {sessions.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{strings.empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {sessions.map((session) => (
            <li key={session.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3" data-testid={`session-${session.id}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {formatMoment(session.last_seen_at, locale)}
                  {session.current ? (
                    <span className="chip ml-2 align-middle" data-testid="session-current">
                      {strings.currentBadge}
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {strings.createdLabel}: {formatMoment(session.created_at, locale)} · {strings.lastSeenLabel}:{' '}
                  {formatMoment(session.last_seen_at, locale)}
                </p>
              </div>
              {session.current ? null : (
                <button
                  type="button"
                  className="btn-light btn-small"
                  disabled={busy !== null}
                  onClick={() => setRevokeTarget(session)}
                  data-testid={`session-revoke-${session.id}`}
                >
                  {busy === session.id ? strings.revoking : strings.revoke}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p className="mt-2 text-sm text-red-700" role="alert" data-testid="sessions-error">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        className="btn-danger btn-small mt-3"
        disabled={busy !== null}
        onClick={() => setRevokeAllOpen(true)}
        data-testid="sessions-revoke-all"
      >
        {strings.revokeAll}
      </button>

      <Modal open={revokeAllOpen} onClose={() => setRevokeAllOpen(false)} title={strings.revokeAllConfirmTitle}>
        <p className="text-sm text-muted">{strings.revokeAllConfirmBody}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-danger btn-small"
            disabled={busy !== null}
            onClick={() => void revokeAll()}
            data-testid="sessions-revoke-all-confirm"
            data-autofocus
          >
            {strings.confirm}
          </button>
          <button type="button" className="btn-light btn-small" onClick={() => setRevokeAllOpen(false)}>
            {strings.cancel}
          </button>
        </div>
      </Modal>

      <Modal
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title={strings.revokeConfirmTitle}
      >
        <p className="text-sm text-muted">{strings.revokeConfirmBody}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-danger btn-small"
            disabled={busy !== null}
            onClick={() => revokeTarget && void revokeOne(revokeTarget)}
            data-testid="session-revoke-confirm"
            data-autofocus
          >
            {strings.confirm}
          </button>
          <button type="button" className="btn-light btn-small" onClick={() => setRevokeTarget(null)}>
            {strings.cancel}
          </button>
        </div>
      </Modal>

      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </section>
  );
}

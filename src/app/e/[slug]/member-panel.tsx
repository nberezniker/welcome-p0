'use client';

import { useState } from 'react';
import Link from 'next/link';

type Strings = {
  memberPanelTitle: string;
  attendanceToggle: string;
  attendanceToggleOnline: string;
  attendanceHint: string;
  directoryConsentLine: string;
  marketingConsentLine: string;
  consentSaved: string;
  openDirectory: string;
  myEventsLink: string;
  errorNetwork: string;
  errorGeneric: string;
};

/**
 * Member participation panel: attendance self-report, directory visibility and
 * event-scoped organizer-announcements consent. All mutations go through the
 * existing APIs; the server rendered the initial state.
 */
export default function EventMemberPanel({
  membershipId,
  eventId,
  initialDirectoryVisible,
  initialPresent,
  initialMarketingConsent,
  isOnline,
  strings,
}: {
  membershipId: string;
  eventId: string;
  initialDirectoryVisible: boolean;
  initialPresent: boolean;
  initialMarketingConsent: boolean;
  isOnline: boolean;
  strings: Strings;
}) {
  const [directoryVisible, setDirectoryVisible] = useState(initialDirectoryVisible);
  const [present, setPresent] = useState(initialPresent);
  const [marketing, setMarketing] = useState(initialMarketingConsent);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const patchMembership = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/me/memberships/${membershipId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) setNote(strings.errorGeneric);
    } catch {
      setNote(strings.errorNetwork);
    } finally {
      setBusy(false);
    }
  };

  const setConsent = async (granted: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/consents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: granted ? 'grant' : 'withdraw',
          purpose: 'organizer_marketing',
          scope_type: 'event',
          scope_id: eventId,
          policy_version: '2026-09-p0',
        }),
      });
      if (!res.ok) setNote(strings.errorGeneric);
    } catch {
      setNote(strings.errorNetwork);
    } finally {
      setBusy(false);
    }
  };

  const setAttendance = async (nextPresent: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/me/memberships/${membershipId}/attendance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ present: nextPresent }),
      });
      if (res.ok) {
        setPresent(nextPresent);
      } else {
        setNote(strings.errorGeneric);
      }
    } catch {
      setNote(strings.errorNetwork);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card mt-6" aria-label={strings.memberPanelTitle} data-testid="member-panel">
      <h2 className="eyebrow">{strings.memberPanelTitle}</h2>

      <div className="mt-3 flex items-start gap-2">
        <input
          id="att-toggle"
          type="checkbox"
          className="mt-1 size-4"
          checked={present}
          disabled={busy}
          onChange={(e) => void setAttendance(e.target.checked)}
          data-testid="attendance-toggle"
        />
        <label htmlFor="att-toggle" className="text-sm font-semibold">
          {isOnline ? strings.attendanceToggleOnline : strings.attendanceToggle}
        </label>
      </div>
      <p className="mt-1 text-xs text-muted">{strings.attendanceHint}</p>

      <div className="mt-4 flex items-start gap-2 border-t border-line pt-3">
        <input
          id="dir-toggle"
          type="checkbox"
          className="mt-1 size-4"
          checked={directoryVisible}
          disabled={busy}
          onChange={(e) => {
            setDirectoryVisible(e.target.checked);
            void patchMembership({ directory_visible: e.target.checked });
          }}
          data-testid="event-directory-toggle"
        />
        <label htmlFor="dir-toggle" className="text-sm">
          {strings.directoryConsentLine}
        </label>
      </div>

      <div className="mt-3 flex items-start gap-2">
        <input
          id="mkt-toggle"
          type="checkbox"
          className="mt-1 size-4"
          checked={marketing}
          disabled={busy}
          onChange={(e) => {
            setMarketing(e.target.checked);
            void setConsent(e.target.checked);
          }}
          data-testid="event-marketing-toggle"
        />
        <label htmlFor="mkt-toggle" className="text-sm">
          {strings.marketingConsentLine}
        </label>
      </div>

      {note ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {note}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/me/events/${eventId}/directory`} className="btn-primary btn-small" data-testid="event-directory-link">
          {strings.openDirectory}
        </Link>
        <Link href="/me/events" className="btn-light btn-small">
          {strings.myEventsLink}
        </Link>
      </div>
    </section>
  );
}

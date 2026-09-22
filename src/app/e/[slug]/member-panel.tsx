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

      {/* Each toggle is a LABEL, not an input beside a label.
          The row is the tap target: a bare `size-4` checkbox is a 16x16 box
          (13x16 as the UA paints it), which is not something a thumb can hit, and
          the measurement that reported it was reading the input's own box rather
          than the clickable area. The label carries `min-h-11` (44px) and wraps
          the control, so clicking anywhere on the row toggles it while the
          checkbox glyph keeps its size and look.

          `items-start` + symmetric `py-3`, NOT `items-center`. These consent
          lines wrap to two or three lines on a 390px screen, and centring the
          control against a multi-line block parks the checkbox in the middle of
          the paragraph — which is a visible regression, not a bigger target. Top
          alignment plus `mt-0.5` (2px, half the difference between the 16px box
          and the 20px line box) keeps the checkbox on the FIRST line, and the
          padding reaches 44px on a one-line row without shoving the text off
          centre. Verified by looking at it, not by measuring it. */}
      <label htmlFor="att-toggle" className="mt-3 flex min-h-11 cursor-pointer items-start gap-2 py-3">
        <input
          id="att-toggle"
          type="checkbox"
          className="mt-0.5 size-4 shrink-0"
          checked={present}
          disabled={busy}
          onChange={(e) => void setAttendance(e.target.checked)}
          data-testid="attendance-toggle"
        />
        <span className="text-sm font-semibold">
          {isOnline ? strings.attendanceToggleOnline : strings.attendanceToggle}
        </span>
      </label>
      <p className="mt-1 text-xs text-muted">{strings.attendanceHint}</p>

      <label
        htmlFor="dir-toggle"
        className="mt-4 flex min-h-11 cursor-pointer items-start gap-2 border-t border-line py-3"
      >
        <input
          id="dir-toggle"
          type="checkbox"
          className="mt-0.5 size-4 shrink-0"
          checked={directoryVisible}
          disabled={busy}
          onChange={(e) => {
            setDirectoryVisible(e.target.checked);
            void patchMembership({ directory_visible: e.target.checked });
          }}
          data-testid="event-directory-toggle"
        />
        <span className="text-sm">{strings.directoryConsentLine}</span>
      </label>

      <label htmlFor="mkt-toggle" className="flex min-h-11 cursor-pointer items-start gap-2 py-3">
        <input
          id="mkt-toggle"
          type="checkbox"
          className="mt-0.5 size-4 shrink-0"
          checked={marketing}
          disabled={busy}
          onChange={(e) => {
            setMarketing(e.target.checked);
            void setConsent(e.target.checked);
          }}
          data-testid="event-marketing-toggle"
        />
        <span className="text-sm">{strings.marketingConsentLine}</span>
      </label>

      {note ? (
        <p className="mt-3 text-sm text-red-700" role="alert">
          {note}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {/* btn-small-tap, not btn-small: these two are compact by design but they
            are still hit with a thumb on the event page, so they take the 44px
            minimum height (.btn-small is 36px and cannot be overridden by a
            utility — see the note on the class in globals.css). */}
        <Link href={`/me/events/${eventId}/directory`} className="btn-primary btn-small-tap" data-testid="event-directory-link">
          {strings.openDirectory}
        </Link>
        <Link href="/me/events" className="btn-light btn-small-tap">
          {strings.myEventsLink}
        </Link>
      </div>
    </section>
  );
}

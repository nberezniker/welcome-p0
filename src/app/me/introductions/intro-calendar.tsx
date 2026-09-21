'use client';

import { useState, useSyncExternalStore } from 'react';
import { fill } from '../../../components/fill';
import {
  calendarFailure,
  meetingRequest,
  type CalendarControlState,
  type CalendarFailure,
} from '../../../domain/meeting-calendar';

export interface IntroCalendarStrings {
  title: string;
  hint: string;
  startLabel: string;
  endLabel: string;
  timezoneLabel: string;
  submit: string;
  sending: string;
  done: string;
  openInGoogle: string;
  addressNotSent: string;
  connectLink: string;
  /** `{env}` is filled with the missing variable NAMES, never their values. */
  notConfigured: string;
  notConnected: string;
  reconnect: string;
  failures: Record<CalendarFailure, string>;
}

/** The device zone never changes under a mounted component, so there is nothing
 * to subscribe to; the callback exists because the hook requires one. */
const subscribeToNothing = () => () => {};

/** The IANA zone this browser is set to — a string, so the snapshot compare is
 * by value and React does not see a new snapshot on every render. */
function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
}

interface Created {
  htmlLink: string | null;
  attendeesSent: number;
}

/**
 * "Put the agreed meeting in MY OWN calendar" — the control the mutual
 * introduction card was missing, on top of the endpoint that already existed
 * (`POST /api/me/calendar/google`, Phase 2 of the interop layer).
 *
 * FOUR RULES SHAPE THIS COMPONENT.
 *
 * 1. **NOTHING IS SENT BEFORE THE USER ACTS.** There is no `useEffect` that
 *    submits, no default time that gets posted "so the form is ready": the only
 *    `fetch` in this file is inside the submit handler. A calendar entry is a
 *    thing the user asked for or it is a bug.
 * 2. **THE STATE IS STATED, NOT IMPLIED.** `state` comes from the server
 *    (`calendarControlState`, src/domain/meeting-calendar.ts) and the card
 *    renders one of: the reason this instance cannot do it at all, the reason
 *    this ACCOUNT has not connected Google yet (with the way to do it), the
 *    form, or the result. It never renders a form whose press could only fail —
 *    the same rule /me/connections follows ("this card offers no button at all
 *    rather than one that could only fail").
 * 3. **THE COUNTERPART'S ADDRESS IS NOT PART OF THIS.** The request body is built
 *    by `meetingRequest`, which has no email field at all; the endpoint's
 *    opt-in (`include_counterpart_email`) is deliberately not offered here. On
 *    success the card says what the server reported (`attendees_sent`), so the
 *    claim is the response's, not this file's.
 * 4. **NO WALL-CLOCK ARITHMETIC.** The inputs are local wall clocks and the zone
 *    is read from the DEVICE (after hydration — a device fact must not be part of
 *    the first render, or the client would hydrate a different value than the
 *    server rendered). The instant is `new Date(local)`, i.e. the device's own
 *    reading of what the user typed, and the same device zone travels as
 *    `timezone`. Letting the user type a zone other than the device's would mean
 *    interpreting one wall clock in another zone's offset — the classic silent
 *    hour-off bug — so the zone is shown rather than edited.
 */
export function IntroCalendar({
  introId,
  counterpartSlug,
  state,
  missingEnv,
  strings,
}: {
  introId: string;
  /** The counterpart's public card slug — what the endpoint resolves. */
  counterpartSlug: string;
  state: CalendarControlState;
  /** Variable NAMES missing on this instance (only read in `not_configured`). */
  missingEnv: readonly string[];
  strings: IntroCalendarStrings;
}) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  // The device's zone, read through the ONE primitive that is allowed to differ
  // between the server render and the client: `useSyncExternalStore` takes the
  // server snapshot (null) for hydration and the client's own value afterwards,
  // so a device fact never becomes a hydration mismatch — and no effect writes
  // state just to learn something about the browser. See rule 4 in the doc above.
  const timezone = useSyncExternalStore(subscribeToNothing, deviceTimezone, () => null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CalendarFailure | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const zoneKnown = timezone !== null && timezone.length > 0;
  const canSubmit = state === 'ready' && zoneKnown && start !== '' && !busy;

  const submit = async () => {
    if (!canSubmit || timezone === null) return;
    const startsAt = new Date(start);
    const endsAt = end === '' ? null : new Date(end);
    if (Number.isNaN(startsAt.getTime()) || (endsAt !== null && Number.isNaN(endsAt.getTime()))) {
      setFailure('invalid_time');
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch('/api/me/calendar/google', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          meetingRequest({
            counterpartSlug,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt ? endsAt.toISOString() : null,
            timezone,
          }),
        ),
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; event?: { html_link?: string | null }; attendees_sent?: number; code?: string }
        | null;
      if (res.ok && payload?.ok) {
        setCreated({ htmlLink: payload.event?.html_link ?? null, attendeesSent: payload.attendees_sent ?? 0 });
        return;
      }
      setFailure(calendarFailure(payload?.code));
    } catch {
      // The request never reached the server: report it as the generic failure
      // rather than guessing a cause, and claim nothing about the calendar.
      setFailure('other');
    } finally {
      setBusy(false);
    }
  };

  const startId = `intro-calendar-start-${introId}`;
  const endId = `intro-calendar-end-${introId}`;

  return (
    <section
      className="mt-3 rounded-xl border border-line px-4 py-3"
      aria-label={strings.title}
      data-testid={`intro-calendar-${introId}`}
      data-calendar-state={state}
    >
      <h3 className="text-sm font-bold">{strings.title}</h3>

      {state === 'not_configured' ? (
        <p className="mt-1.5 text-xs text-muted" data-testid={`intro-calendar-unavailable-${introId}`}>
          {fill(strings.notConfigured, { env: missingEnv.join(', ') })}
        </p>
      ) : null}

      {state === 'not_connected' || state === 'expired' || state === 'revoked' ? (
        <div className="mt-1.5">
          <p className="text-xs text-muted" data-testid={`intro-calendar-connection-${introId}`}>
            {state === 'not_connected' ? strings.notConnected : strings.reconnect}
          </p>
          <a href="/me/connections" className="btn-light mt-2" data-testid={`intro-calendar-connect-${introId}`}>
            {strings.connectLink}
          </a>
        </div>
      ) : null}

      {created ? (
        <div className="mt-1.5" data-testid={`intro-calendar-done-${introId}`}>
          <p className="text-sm font-semibold" role="status">
            {strings.done}
          </p>
          {/* `attendees_sent` is the endpoint's own number: 0 means no address of
              the counterpart's went to Google, and the card says so. */}
          {created.attendeesSent === 0 ? <p className="mt-1 text-xs text-muted">{strings.addressNotSent}</p> : null}
          {created.htmlLink ? (
            <a
              href={created.htmlLink}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-light mt-2"
              data-testid={`intro-calendar-open-${introId}`}
            >
              {strings.openInGoogle}
            </a>
          ) : null}
        </div>
      ) : null}

      {state === 'ready' && !created ? (
        <>
          <p className="mt-1.5 text-xs text-muted">{strings.hint}</p>
          <div className="mt-3 flex flex-col gap-3">
            <div>
              <label className="label" htmlFor={startId}>
                {strings.startLabel}
              </label>
              <input
                id={startId}
                type="datetime-local"
                className="input"
                value={start}
                onChange={(event) => setStart(event.target.value)}
                data-testid={`intro-calendar-start-${introId}`}
              />
            </div>
            <div>
              <label className="label" htmlFor={endId}>
                {strings.endLabel}
              </label>
              <input
                id={endId}
                type="datetime-local"
                className="input"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
                data-testid={`intro-calendar-end-${introId}`}
              />
            </div>
            <p className="text-xs text-muted">
              {strings.timezoneLabel}:{' '}
              <span className="font-mono" data-testid={`intro-calendar-timezone-${introId}`}>
                {timezone ?? '…'}
              </span>
            </p>
            <div>
              <button
                type="button"
                className="btn-primary btn-small"
                disabled={!canSubmit}
                onClick={() => void submit()}
                data-testid={`intro-calendar-submit-${introId}`}
              >
                {busy ? strings.sending : strings.submit}
              </button>
            </div>
          </div>
          {timezone !== null && !zoneKnown ? (
            <p className="mt-2 text-sm text-red-700" role="alert" data-testid={`intro-calendar-no-timezone-${introId}`}>
              {strings.failures.invalid_timezone}
            </p>
          ) : null}
        </>
      ) : null}

      {failure ? (
        <p className="mt-2 text-sm text-red-700" role="alert" data-testid={`intro-calendar-error-${introId}`}>
          {strings.failures[failure]}
        </p>
      ) : null}
    </section>
  );
}

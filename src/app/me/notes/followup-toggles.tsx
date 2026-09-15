'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Toast, useToast } from '../../../components/modal';

/**
 * Opt-in switches for the two Phase-4 follow-up mechanics (design §B5).
 *
 * Rendered only while at least one mechanic is enabled on the instance — with
 * both flags off the server sends no state and this component does not exist,
 * which is the same rule the endpoint follows (404).
 *
 * The switches are native checkboxes with an optimistic write, the established
 * opt-in pattern in this codebase (membership-editor): the state chip next to
 * them is the server's answer for the mechanic, and a failed write reverts the
 * box instead of leaving the UI claiming something the server never stored.
 *
 * The reminder switch is DISABLED until `service_channel` consent is granted.
 * That consent is not a technicality: without it nothing would be sent, and a
 * switch that silently does nothing is worse than no switch. The copy says why
 * and links to the page that owns that consent — opting in here deliberately
 * does not grant it (a narrow «remind me» must not also unlock introduction
 * notices).
 */

export type FollowupMechanic = 'reminders' | 'digest';

export interface FollowupState {
  reminders: boolean;
  digest: boolean;
}

type Strings = {
  title: string;
  subtitle: string;
  remindersLabel: string;
  remindersHint: string;
  digestLabel: string;
  digestHint: string;
  stateOn: string;
  stateOff: string;
  savedToast: string;
  stopHint: string;
  remindersNeedsConsent: string;
  openPrivacy: string;
  errorNetwork: string;
};

export function FollowupToggles({
  initial,
  enabled,
  serviceChannelConsent,
  strings,
}: {
  initial: FollowupState;
  enabled: { reminders: boolean; digest: boolean };
  serviceChannelConsent: boolean;
  strings: Strings;
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState<FollowupMechanic | null>(null);
  const toast = useToast();

  const write = async (mechanic: FollowupMechanic, optedIn: boolean) => {
    const previous = state[mechanic];
    setState((current) => ({ ...current, [mechanic]: optedIn }));
    setBusy(mechanic);
    try {
      const res = await fetch('/api/me/followup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mechanic, opted_in: optedIn }),
      });
      if (!res.ok) {
        setState((current) => ({ ...current, [mechanic]: previous }));
        toast.show(strings.errorNetwork, 'error');
        return;
      }
      const payload = (await res.json().catch(() => null)) as { opted_in?: boolean } | null;
      if (typeof payload?.opted_in === 'boolean') {
        // Trust the server's answer, not the optimistic guess.
        setState((current) => ({ ...current, [mechanic]: payload.opted_in as boolean }));
      }
      toast.show(strings.savedToast);
    } catch {
      setState((current) => ({ ...current, [mechanic]: previous }));
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(null);
    }
  };

  const rows: { mechanic: FollowupMechanic; label: string; hint: string; blocked: boolean }[] = [];
  if (enabled.reminders) {
    rows.push({
      mechanic: 'reminders',
      label: strings.remindersLabel,
      hint: strings.remindersHint,
      blocked: !serviceChannelConsent,
    });
  }
  if (enabled.digest) {
    rows.push({ mechanic: 'digest', label: strings.digestLabel, hint: strings.digestHint, blocked: false });
  }
  if (rows.length === 0) return null;

  return (
    <section className="card" aria-labelledby="followup-heading" data-testid="followup-card">
      <h2 id="followup-heading" className="text-lg font-bold tracking-tight">
        {strings.title}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">{strings.subtitle}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.mechanic}
            className="card-tight flex flex-wrap items-start justify-between gap-3"
            data-testid={`followup-${row.mechanic}`}
          >
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <input
                id={`followup-${row.mechanic}`}
                type="checkbox"
                className="mt-1 size-4"
                checked={state[row.mechanic]}
                disabled={busy === row.mechanic || row.blocked}
                onChange={(e) => void write(row.mechanic, e.target.checked)}
                aria-describedby={`followup-hint-${row.mechanic}`}
                data-testid={`followup-toggle-${row.mechanic}`}
              />
              <div className="min-w-0">
                <label htmlFor={`followup-${row.mechanic}`} className="text-sm font-semibold">
                  {row.label}
                </label>
                <p id={`followup-hint-${row.mechanic}`} className="mt-0.5 text-xs leading-relaxed text-muted">
                  {row.hint}
                </p>
                {row.blocked ? (
                  <p className="mt-1 text-xs text-amber-900" data-testid={`followup-consent-hint-${row.mechanic}`}>
                    {strings.remindersNeedsConsent}{' '}
                    <Link href="/me/privacy" className="underline">
                      {strings.openPrivacy}
                    </Link>
                  </p>
                ) : null}
              </div>
            </div>
            <span
              className={state[row.mechanic] ? 'chip' : 'chip !bg-paper !text-muted'}
              data-testid={`followup-state-${row.mechanic}`}
            >
              {state[row.mechanic] ? strings.stateOn : strings.stateOff}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-muted">{strings.stopHint}</p>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </section>
  );
}

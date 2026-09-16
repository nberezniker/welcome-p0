'use client';

import { useState } from 'react';

/**
 * One Google provider card on /me/connections (Phase 2).
 *
 * WHAT IT DOES ON MOUNT: nothing. There is no useEffect, no fetch and no
 * prefetch — every number below arrived in the server-rendered HTML, and the
 * first thing that ever reaches Google is the user's own click on "Connect"
 * (which navigates to /api/oauth/google/start, a route that only builds a URL).
 * "Nothing is fetched from Google before the user presses connect" is therefore a
 * property of this component's shape.
 *
 * WHAT IT REFUSES TO SHOW:
 *   - no token, no expiry instant, no scope list beyond the honest state word;
 *   - no success it cannot prove. A disconnect that leaves Google's copy alive
 *     says so (`revoked_at_google: false`), because the alternative is a green
 *     tick over a permission that still exists.
 */

export type GoogleProviderId = 'google-contacts' | 'google-calendar';

/** Mirrors src/domain/google-oauth.ts `GoogleGrantState` (plus the instance state). */
export type GooglePanelState = 'connected' | 'not_connected' | 'expired' | 'revoked' | 'not_configured';

export interface GooglePanelStrings {
  panelTitle: string;
  stateConnected: string;
  stateNotConnected: string;
  stateExpired: string;
  stateRevoked: string;
  stateNotConfigured: string;
  /**
   * The connect control NAMES the provider (`{provider}` is filled with
   * `providerName` below), because a bare "Connect" appeared twice on one page
   * and told the user nothing about which Google account they were about to
   * open. There is deliberately no unnamed variant left in the dictionaries.
   */
  connectProvider: string;
  reconnectProvider: string;
  disconnect: string;
  disconnecting: string;
  connectedAt: string;
  notConfiguredHelp: string;
  revokedHelp: string;
  expiredHelp: string;
  idleHelp: string;
  readsLabel: string;
  writesLabel: string;
  checkTitle: string;
  checkButton: string;
  checkBusy: string;
  checkNote: string;
  truncated: string;
  errorReconnect: string;
  errorScope: string;
  errorUnavailable: string;
  errorRateLimited: string;
  errorGeneric: string;
  /** Reused from the address-book import: the result of a "who is here" run. */
  resultSome: string;
  resultOne: string;
  resultNone: string;
  unmatched: string;
  matchesTruncated: string;
  openCard: string;
}

export interface GooglePanelProps {
  provider: GoogleProviderId;
  /** Localized provider title (providers.<id>.title) — the name the connect
   *  control has to carry, and the reason it is passed in rather than derived. */
  providerName: string;
  /** False when this instance has no Google OAuth client at all. */
  configured: boolean;
  /** Missing env NAMES when not configured (never values). */
  missingEnv: readonly string[];
  state: GooglePanelState;
  /** ISO instant, or null. Only ever shown for a living grant. */
  connectedAt: string | null;
  /** Exactly what this provider reads / writes, for THIS provider. */
  reads: string;
  writes: string;
  strings: GooglePanelStrings;
}

interface ImportResult {
  scanned: number;
  matched_count: number;
  matched: { display_name: string; slug: string; headline: string | null }[];
  unmatched_count: number;
  matched_truncated: boolean;
  truncated?: boolean;
}

/** `{count}` interpolation, matching src/i18n/index.ts. */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

function formatConnectedAt(iso: string, template: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return template;
  // Server and client must agree, otherwise hydration mismatches. `toISOString`
  // is the one rendering both sides produce identically.
  return fill(template, { date: date.toISOString().slice(0, 10) });
}

const STATE_CLASS: Record<GooglePanelState, string> = {
  connected: 'chip !bg-emerald-50 !text-emerald-800',
  not_connected: 'chip !bg-paper !text-muted',
  expired: 'chip !bg-amber-50 !text-amber-900',
  revoked: 'chip !bg-amber-50 !text-amber-900',
  not_configured: 'chip !bg-paper !text-muted',
};

export function GoogleConnectPanel({
  provider,
  providerName,
  configured,
  missingEnv,
  state,
  connectedAt,
  reads,
  writes,
  strings,
}: GooglePanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const label: Record<GooglePanelState, string> = {
    connected: strings.stateConnected,
    not_connected: strings.stateNotConnected,
    expired: strings.stateExpired,
    revoked: strings.stateRevoked,
    not_configured: strings.stateNotConfigured,
  };

  // A grant row exists in every state except "never connected" and "this
  // instance cannot connect" — an expired or revoked permission is still
  // something the user is entitled to clear.
  const hasGrant = state === 'connected' || state === 'expired' || state === 'revoked';

  const help =
    !configured
      ? fill(strings.notConfiguredHelp, { env: missingEnv.join(', ') })
      : state === 'revoked'
        ? strings.revokedHelp
        : state === 'expired'
          ? strings.expiredHelp
          : state === 'not_connected'
            ? strings.idleHelp
            : null;

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/me/oauth/google?provider=${provider}`, { method: 'DELETE' });
      if (res.ok) {
        // The server owns the state; re-render from it rather than guessing.
        window.location.reload();
        return;
      }
      setError(res.status === 401 ? strings.errorGeneric : strings.errorUnavailable);
    } catch {
      setError(strings.errorUnavailable);
    } finally {
      setBusy(false);
    }
  };

  const runContactsCheck = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/me/contacts/google', { method: 'POST' });
      const payload = (await res.json().catch(() => null)) as
        | (Partial<ImportResult> & { code?: string })
        | null;
      if (!res.ok) {
        const code = payload?.code;
        setError(
          code === 'reconnect_required' || code === 'not_connected'
            ? strings.errorReconnect
            : code === 'scope_missing'
              ? strings.errorScope
              : code === 'rate_limited'
                ? strings.errorRateLimited
                : strings.errorUnavailable,
        );
        return;
      }
      setResult({
        scanned: payload?.scanned ?? 0,
        matched_count: payload?.matched_count ?? 0,
        matched: payload?.matched ?? [],
        unmatched_count: payload?.unmatched_count ?? 0,
        matched_truncated: payload?.matched_truncated ?? false,
        truncated: payload?.truncated ?? false,
      });
    } catch {
      setError(strings.errorUnavailable);
    } finally {
      setBusy(false);
    }
  };

  const headline =
    result === null
      ? null
      : result.matched_count === 0
        ? fill(strings.resultNone, { count: result.scanned })
        : result.matched_count === 1
          ? strings.resultOne
          : fill(strings.resultSome, { count: result.matched_count });

  const startHref = `/api/oauth/google/start?provider=${provider}`;

  return (
    <div className="mt-4 rounded-xl bg-paper px-4 py-3" data-testid={`google-panel-${provider}`}>
      {/* 1. Title + per-user state. One unit: the state word and the action that
          changes it sit in the same visual block, so "not connected" is read
          together with the control that fixes it. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold tracking-tight">{strings.panelTitle}</h3>
        <span
          className={STATE_CLASS[state]}
          data-testid={`google-state-${provider}`}
          data-google-state={state}
        >
          {label[state]}
        </span>
      </div>

      {/* 2. THE action, unmistakable: a primary button, full width on a phone,
          directly under the state and ABOVE the explanation — and it names the
          provider, so the two Google cards on this page are told apart by the
          control itself rather than by the paragraph underneath it. */}
      {configured && state !== 'connected' ? (
        <a
          href={startHref}
          className="btn-primary mt-3 w-full sm:w-auto"
          data-testid={`google-connect-${provider}`}
          data-google-action={hasGrant ? 'reconnect' : 'connect'}
          // The route requires a session: signed out it sends you to /login,
          // and no Google flow, state or grant is created.
          rel="nofollow"
        >
          {hasGrant
            ? fill(strings.reconnectProvider, { provider: providerName })
            : fill(strings.connectProvider, { provider: providerName })}
        </a>
      ) : null}

      {/* 3. Then the explanation, in this order because the button above is what
          the sentences refer to. `notConfiguredHelp` is the honest per-instance
          branch: with no OAuth client there is no control at all — a disabled
          button would only invite a press that cannot work. */}
      {help ? (
        <p className="mt-2 text-xs text-muted" data-testid={`google-help-${provider}`}>
          {help}
        </p>
      ) : null}

      {configured && state === 'connected' && connectedAt ? (
        <p className="mt-2 text-xs text-muted" data-testid={`google-connected-at-${provider}`}>
          {formatConnectedAt(connectedAt, strings.connectedAt)}
        </p>
      ) : null}

      {/* Exactly what is read and what is written — the reason this card exists. */}
      <dl className="mt-3 flex flex-col gap-2 text-xs">
        <div data-testid={`google-reads-${provider}`}>
          <dt className="font-semibold">{strings.readsLabel}</dt>
          <dd className="text-muted">{reads}</dd>
        </div>
        <div data-testid={`google-writes-${provider}`}>
          <dt className="font-semibold">{strings.writesLabel}</dt>
          <dd className="text-muted">{writes}</dd>
        </div>
      </dl>

      {provider === 'google-contacts' && configured && state === 'connected' ? (
        <div className="mt-3">
          <p className="text-sm font-semibold">{strings.checkTitle}</p>
          <button
            type="button"
            className="btn-light btn-small mt-1"
            data-testid="google-check-google-contacts"
            disabled={busy}
            onClick={() => {
              void runContactsCheck();
            }}
          >
            {busy ? strings.checkBusy : strings.checkButton}
          </button>
          <p className="mt-1 text-xs text-muted">{strings.checkNote}</p>
        </div>
      ) : null}

      {/* Disconnect stays a quieter secondary control, and at the END of the
          card: withdrawing a permission is the deliberate, rarer action, so it
          must not compete with the one the card exists for. The confirmation
          behaviour is unchanged — the server owns the state, the page reloads. */}
      {configured && hasGrant ? (
        <div className="mt-3 border-t border-line pt-3">
          <button
            type="button"
            className="btn-light btn-small"
            data-testid={`google-disconnect-${provider}`}
            disabled={busy}
            onClick={() => {
              void disconnect();
            }}
          >
            {busy ? strings.disconnecting : strings.disconnect}
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-amber-900" role="alert" data-testid={`google-error-${provider}`}>
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="mt-3 rounded-lg bg-white px-3 py-2" aria-live="polite" data-testid="google-check-result">
          <p className="text-sm font-semibold" data-testid="google-check-headline">
            {headline}
          </p>
          {result.matched.length > 0 ? (
            <ul className="mt-1.5 flex flex-col gap-1 text-sm">
              {result.matched.map((match) => (
                <li key={match.slug}>
                  <a className="font-semibold underline" href={`/p/${match.slug}`}>
                    {match.display_name}
                  </a>
                  {match.headline ? <span className="text-muted"> — {match.headline}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1.5 text-xs text-muted">
            {result.unmatched_count > 0 ? `${fill(strings.unmatched, { count: result.unmatched_count })} ` : ''}
            {result.matched_truncated ? strings.matchesTruncated : ''}
          </p>
          {result.truncated ? <p className="mt-1 text-xs text-amber-900">{strings.truncated}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

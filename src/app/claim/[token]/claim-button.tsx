'use client';

import { useState } from 'react';
import Link from 'next/link';

type Strings = {
  claimCta: string;
  claiming: string;
  done: string;
  notice: string;
  dataNote: string;
  setupTitle: string;
  setupTags: string;
  setupVisibility: string;
  openProfile: string;
  openEvent: string;
  openMe: string;
  signInToRetry: string;
  emailMismatch: string;
  alreadyUsed: string;
  expired: string;
  notAllowed: string;
  errorGeneric: string;
  errorNetwork: string;
};

interface ClaimResult {
  event_id: string | null;
  profile_created: boolean;
}

/** Claim confirmation for /claim/[token]. The token is spent only by this
 * POST — never by opening the page. Success shows a verify-and-setup step. */
export default function ClaimButton({
  token,
  eventId,
  strings,
}: {
  token: string;
  eventId: string | null;
  strings: Strings;
}) {
  const [state, setState] = useState<'idle' | 'claiming' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ClaimResult | null>(null);

  async function claim() {
    setState('claiming');
    setMessage(null);
    try {
      const res = await fetch('/api/registration-claims', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as ClaimResult & { notice?: string } | null;
        setResult({ event_id: body?.event_id ?? eventId, profile_created: body?.profile_created ?? false });
        setState('done');
        return;
      }
      const err = (await res.json().catch(() => null)) as { code?: string } | null;
      setState('error');
      if (res.status === 401) setMessage(strings.signInToRetry);
      else if (err?.code === 'email_mismatch') setMessage(strings.emailMismatch);
      else if (err?.code === 'already_used') setMessage(strings.alreadyUsed);
      else if (err?.code === 'expired') setMessage(strings.expired);
      else if (err?.code === 'claim_not_allowed') setMessage(strings.notAllowed);
      else setMessage(strings.errorGeneric);
    } catch {
      setState('error');
      setMessage(strings.errorNetwork);
    }
  }

  if (state === 'done') {
    return (
      <div className="mt-6" data-testid="claim-done">
        <p className="rounded-xl bg-mint px-4 py-3 text-sm font-semibold text-pine">{strings.done}</p>
        <p className="mt-2 text-sm text-ink">{strings.notice}</p>
        <p className="mt-1 text-xs text-muted">{strings.dataNote}</p>

        <div className="mt-4 rounded-xl border border-line bg-paper p-4">
          <h3 className="text-sm font-bold">{strings.setupTitle}</h3>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-muted">
            <li>✓ {strings.setupTags}</li>
            <li>✓ {strings.setupVisibility}</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/me/profile" className="btn-primary btn-small" data-testid="claim-open-profile">
              {strings.openProfile}
            </Link>
            {result?.event_id ? (
              <Link href="/me/events" className="btn-light btn-small">
                {strings.openEvent}
              </Link>
            ) : null}
            <Link href="/me" className="btn-light btn-small">
              {strings.openMe}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <button type="button" onClick={() => void claim()} disabled={state === 'claiming'} className="btn-accent" data-testid="claim-button">
        {state === 'claiming' ? strings.claiming : strings.claimCta}
      </button>
      {message && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';

type Strings = {
  joinCta: string;
  joining: string;
  joinCodeLabel: string;
  joinCodeHint: string;
  joinProfileRequired: string;
  joinFull: string;
  joinForbidden: string;
  joinNotActive: string;
  signInToJoin: string;
  errorGeneric: string;
  errorNetwork: string;
  joined: string;
};

/** Client-side join affordance for /e/[slug]; supports join-code events. */
export default function JoinEventButton({
  eventId,
  needsCode,
  strings,
}: {
  eventId: string;
  needsCode: boolean;
  strings: Strings;
}) {
  const [state, setState] = useState<'idle' | 'joining' | 'joined' | 'error'>('idle');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  async function join() {
    setState('joining');
    setMessage(null);
    try {
      const res = await fetch(`/api/events/${eventId}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(needsCode ? { join_code: code.trim() } : {}),
      });
      if (res.ok) {
        setState('joined');
        return;
      }
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      setState('error');
      if (body?.code === 'profile_required') setMessage(strings.joinProfileRequired);
      else if (body?.code === 'event_full') setMessage(strings.joinFull);
      else if (body?.code === 'join_forbidden') setMessage(strings.joinForbidden);
      else if (body?.code === 'event_not_active') setMessage(strings.joinNotActive);
      else if (res.status === 401) setMessage(strings.signInToJoin);
      else setMessage(strings.errorGeneric);
    } catch {
      setState('error');
      setMessage(strings.errorNetwork);
    }
  }

  if (state === 'joined') {
    return (
      <p className="mt-6 rounded-xl bg-mint px-4 py-3 text-sm font-semibold text-pine" role="status" data-testid="join-success">
        {strings.joined}
      </p>
    );
  }

  return (
    <div className="mt-6" data-testid="join-area">
      {needsCode ? (
        <div className="mb-3">
          <label className="label" htmlFor="join-code">
            {strings.joinCodeLabel}
          </label>
          <input
            id="join-code"
            className="input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            aria-describedby="join-code-hint"
            data-testid="join-code-input"
          />
          <p id="join-code-hint" className="mt-1 text-xs text-muted">
            {strings.joinCodeHint}
          </p>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => void join()}
        disabled={state === 'joining' || (needsCode && code.trim() === '')}
        className="btn-accent"
        data-testid="join-button"
      >
        {state === 'joining' ? strings.joining : strings.joinCta}
      </button>
      {message && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

'use client';

import { useState } from 'react';
import { CopyButton } from '../../../../components/copy-button';

type Strings = {
  invite: string;
  invited: string;
  inviteTitleTemplate: string;
  inviteHint: string;
  claimUrlLabel: string;
  claimCopied: string;
  copyLabel: string;
  claimAlready: string;
  claimNotAllowed: string;
  errorGeneric: string;
  errorNetwork: string;
};

/** Generates a one-time claim link via the invite endpoint and reveals it. */
export function InviteButton({
  eventId,
  registrationId,
  regName,
  strings,
}: {
  eventId: string;
  registrationId: string;
  regName: string;
  strings: Strings;
}) {
  const [claimUrl, setClaimUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'claimed' | 'not_allowed' | 'error'>('idle');

  const invite = async () => {
    setState('busy');
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/registrations/${registrationId}/invite`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => null)) as { claim_url?: string } | null;
      if (res.ok && body?.claim_url) {
        setClaimUrl(body.claim_url);
        setState('done');
      } else if (res.status === 409) {
        setState('claimed');
      } else if (res.status === 403) {
        setState('not_allowed');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  };

  if (state === 'done' && claimUrl) {
    return (
      <div className="mt-2 rounded-lg bg-paper p-3" data-testid="claim-link-box">
        <p className="text-xs font-bold uppercase tracking-wide text-muted">{strings.claimUrlLabel}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded border border-line bg-white px-2 py-1 text-xs">{claimUrl}</code>
          <CopyButton value={claimUrl} label={strings.copyLabel} copiedLabel={strings.claimCopied} testId="copy-claim-url" />
        </div>
        <p className="mt-1 text-xs text-muted">{strings.inviteHint}</p>
      </div>
    );
  }

  return (
    <div>
      <button type="button" className="btn-light btn-small" disabled={state === 'busy'} onClick={() => void invite()} data-testid={`invite-${registrationId}`}>
        {state === 'claimed' ? strings.claimAlready : state === 'busy' ? strings.invited : strings.invite}
      </button>
      {state === 'not_allowed' || state === 'error' ? (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {state === 'not_allowed' ? strings.claimNotAllowed : strings.errorGeneric}
        </p>
      ) : null}
      <span className="sr-only">{strings.inviteTitleTemplate}</span>
    </div>
  );
}

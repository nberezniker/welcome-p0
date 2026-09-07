'use client';

import { useState } from 'react';
import { Modal, Toast, useToast } from '../../../components/modal';

type Strings = {
  linkButton: string;
  linking: string;
  step1: string;
  deepLink: string;
  step2: string;
  confirmButton: string;
  confirming: string;
  confirmed: string;
  expiryNote: string;
  unlink: string;
  unlinking: string;
  unlinkConfirmText: string;
  cancel: string;
  linkFailed: string;
  errorNetwork: string;
};

type Phase = 'idle' | 'linked_created' | 'web_confirmed';

/**
 * Two-sided Telegram binding (AC-11): create challenge → open deep link →
 * confirm in THIS web session → finish with /start in Telegram.
 */
export function TelegramBinding({
  strings,
}: {
  strings: Strings;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [rawToken, setRawToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const toast = useToast();

  const startChallenge = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/channels/telegram/challenge', { method: 'POST' });
      const payload = (await res.json().catch(() => null)) as
        | { deep_link?: string; challenge?: { id: string } }
        | null;
      if (res.ok && payload?.deep_link) {
        const link = payload.deep_link;
        const match = /[?&]start=link_([A-Za-z0-9_-]+)/.exec(link);
        setDeepLink(link);
        setRawToken(match?.[1] ?? null);
        setPhase('linked_created');
      } else {
        toast.show(strings.linkFailed, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!rawToken) return;
    setBusy(true);
    try {
      const res = await fetch('/api/channels/telegram/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: rawToken }),
      });
      if (res.ok) {
        setPhase('web_confirmed');
      } else if (res.status === 404) {
        toast.show(strings.linkFailed, 'error');
        setPhase('idle');
      } else {
        toast.show(strings.errorNetwork, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/channels/telegram', { method: 'DELETE' });
      if (res.ok) {
        setPhase('idle');
        setDeepLink(null);
        setRawToken(null);
        setUnlinkOpen(false);
        window.location.reload();
      } else {
        toast.show(strings.errorNetwork, 'error');
      }
    } catch {
      toast.show(strings.errorNetwork, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {phase === 'idle' ? (
        <button type="button" className="btn-primary self-start" disabled={busy} onClick={() => void startChallenge()} data-testid="tg-link">
          {busy ? strings.linking : strings.linkButton}
        </button>
      ) : null}

      {deepLink && phase !== 'idle' ? (
        <div className="card-tight" data-testid="tg-challenge">
          <p className="text-sm">{strings.step1}</p>
          <a href={deepLink} className="btn-light btn-small mt-2" target="_blank" rel="noopener noreferrer" data-testid="tg-deeplink">
            {strings.deepLink} ↗
          </a>
          <p className="mt-1 text-xs text-muted">{strings.expiryNote}</p>
          {phase === 'linked_created' ? (
            <div className="mt-4 border-t border-line pt-3">
              <p className="text-sm">{strings.step2}</p>
              <button type="button" className="btn-primary btn-small mt-2" disabled={busy || !rawToken} onClick={() => void confirm()} data-testid="tg-confirm">
                {busy ? strings.confirming : strings.confirmButton}
              </button>
            </div>
          ) : null}
          {phase === 'web_confirmed' ? (
            <p className="mt-4 rounded-lg bg-mint px-3 py-2 text-sm font-semibold text-pine" role="status" data-testid="tg-confirmed">
              {strings.confirmed}
            </p>
          ) : null}
        </div>
      ) : null}

      <button type="button" className="btn-outline btn-small self-start !text-accent" disabled={busy} onClick={() => setUnlinkOpen(true)} data-testid="tg-unlink">
        {busy ? strings.unlinking : strings.unlink}
      </button>

      <Modal open={unlinkOpen} onClose={() => setUnlinkOpen(false)} title={strings.unlink}>
        <p className="text-sm text-muted">{strings.unlinkConfirmText}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-light btn-small" onClick={() => setUnlinkOpen(false)}>
            {strings.cancel}
          </button>
          <button type="button" className="btn-accent btn-small" disabled={busy} onClick={() => void unlink()}>
            {busy ? strings.unlinking : strings.unlink}
          </button>
        </div>
      </Modal>
      <Toast message={toast.message} kind={toast.kind} onDone={toast.clear} />
    </div>
  );
}

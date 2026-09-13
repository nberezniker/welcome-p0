'use client';

import { useState } from 'react';
import { copyText } from '../../../components/copy-button';

/**
 * "Share" affordance: the Web Share API when the platform has it (mobile), and a
 * clipboard copy with visible confirmation otherwise — the same URL either way
 * (`APP_BASE_URL` + /p/<slug>, the payload the QR code encodes).
 */
export function ShareButton({
  url,
  title,
  shareLabel,
  copiedLabel,
}: {
  url: string;
  title: string;
  shareLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const share = async () => {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title, url });
        return;
      }
    } catch {
      // The user dismissed the sheet (AbortError) or sharing is unavailable:
      // fall through to copying rather than leaving the button dead.
    }
    const ok = await copyText(url);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button type="button" className="btn-light" onClick={() => void share()} data-testid="pubcard-share">
      {copied ? copiedLabel : shareLabel}
    </button>
  );
}

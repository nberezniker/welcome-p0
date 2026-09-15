'use client';

import { useState } from 'react';
import { SHARE_NETWORKS, shareHref, type ShareNetwork } from '../domain/share';
import { copyText } from './copy-button';

/**
 * Share affordances for a card or an event page: plain deeplinks to X /
 * WhatsApp / Telegram / LinkedIn (`src/domain/share.ts`) plus the native share
 * sheet when the platform has one.
 *
 * Every link is `rel="noopener noreferrer"` and `target="_blank"`: an outbound
 * share must never hand the opener window to the target page, and the referrer
 * is not the target's business. Nothing here posts anything — the visitor's
 * click carries the action (A1.1).
 */
export function ShareLinks({
  url,
  title,
  labels,
  shareLabel,
  copiedLabel,
  testId = 'share-links',
}: {
  url: string;
  title: string;
  labels: Record<ShareNetwork, string>;
  shareLabel: string;
  copiedLabel: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);

  const nativeShare = async () => {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title, url });
        return;
      }
    } catch {
      // Sheet dismissed (AbortError) or unavailable — fall through to copying.
    }
    if (await copyText(url)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const hrefs = SHARE_NETWORKS.map((network) => ({ network, href: shareHref(network, url, title) })).filter(
    (item): item is { network: ShareNetwork; href: string } => item.href !== null,
  );
  if (hrefs.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
      <button type="button" className="btn-light btn-small" onClick={() => void nativeShare()} data-testid="share-native">
        {copied ? copiedLabel : shareLabel}
      </button>
      {hrefs.map(({ network, href }) => (
        <a
          key={network}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-light btn-small"
          data-testid={`share-${network}`}
        >
          {labels[network]}
        </a>
      ))}
    </div>
  );
}

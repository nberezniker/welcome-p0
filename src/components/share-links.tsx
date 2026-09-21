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
 *
 * TWO MODES, BECAUSE THE TWO PAGES NEED DIFFERENT THINGS. By default the row is
 * rendered open: on the public card the share strip IS the card's own short row
 * of affordances, next to the vCard and the QR, and hiding it would hide the
 * card's "pass me on" action. With `disclosure` the same controls collapse
 * behind one labelled control — what the event page needs, where the five share
 * controls sat in a row competing with the join action and the native-share
 * `Share…` button duplicated the four deeplinks beside it. In that mode the
 * revealed controls render at FULL size instead of `btn-small`: a panel the
 * visitor opens deliberately on a phone is a touch surface, and 36px is not a
 * touch target.
 *
 * One component rather than two: the network list, the hrefs and the
 * `rel`/`target` discipline are the interop layer's contract (A1.1/A1.2) and
 * duplicating them per page is how the two surfaces would drift apart.
 */
export function ShareLinks({
  url,
  title,
  labels,
  shareLabel,
  copiedLabel,
  testId = 'share-links',
  disclosure,
}: {
  url: string;
  title: string;
  labels: Record<ShareNetwork, string>;
  shareLabel: string;
  copiedLabel: string;
  testId?: string;
  /**
   * Present ⇒ the controls collapse behind one control labelled `label`. The
   * dictionary owns the wording: a collapse cannot arrive without a name.
   */
  disclosure?: { label: string };
}) {
  const [copied, setCopied] = useState(false);
  // Collapsed mode starts CLOSED — a disclosure rendered open is not one. The
  // default mode has nothing to open and shows its row as it always has.
  const [open, setOpen] = useState(disclosure === undefined);

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

  // `min-w-11` in the collapsed mode for a reason the default mode does not
  // have: the revealed panel is a phone touch surface opened on purpose, and the
  // shortest label here ("X") is 43.5px wide on its own — a 44px-height target
  // that is 43px across is still a miss.
  const controlClass = disclosure ? 'btn-light min-w-11' : 'btn-light btn-small';
  const panelId = `${testId}-options`;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
      {disclosure ? (
        <button
          type="button"
          className="btn-light"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          data-testid="share-toggle"
        >
          {disclosure.label}
        </button>
      ) : null}
      {open ? (
        <div
          id={disclosure ? panelId : undefined}
          className="flex flex-wrap items-center gap-2"
          data-testid={disclosure ? `${testId}-options` : undefined}
        >
          <button
            type="button"
            className={controlClass}
            onClick={() => void nativeShare()}
            data-testid="share-native"
          >
            {copied ? copiedLabel : shareLabel}
          </button>
          {hrefs.map(({ network, href }) => (
            <a
              key={network}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={controlClass}
              data-testid={`share-${network}`}
            >
              {labels[network]}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

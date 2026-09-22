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
 * `Share…` button duplicated the four deeplinks beside it.
 *
 * BOTH MODES ARE 44px. They used to differ: the card's open row was `btn-small`
 * (36px, "not a touch target" by its own words) on the theory that a compact
 * strip is a different kind of control. It is not — it is the row a person taps
 * to hand the card to someone else, and it was the only public-card control below
 * the product's floor. Both modes now clear 44px on BOTH axes and keep the
 * compact type (`.btn-small-tap`); `min-w-11` is what stops the "X" label from
 * being a 36px-wide box. Measured every run by tests/e2e/design-gate.spec.ts.
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

  // `min-w-11` in BOTH modes, for a reason the taller box alone does not cover:
  // the shortest label here ("X") is ~36px wide on its own, so a 44px-tall target
  // that is 36px across is still a miss. The revealed event panel and the card's
  // open row are both phone touch surfaces, and this row IS the card's "pass me
  // on" action — the four deeplinks a person taps with a thumb.
  //
  // The card's row therefore uses `.btn-small-tap` (compact TYPE and padding,
  // 44px box) instead of `.btn-small`: it stays the dense row it looks like while
  // meeting the product's 44px floor. That class exists because `.btn-small` is
  // unlayered CSS and beats the layered `min-h-11` utility — see globals.css.
  const controlClass = disclosure ? 'btn-light min-w-11' : 'btn-light btn-small-tap min-w-11';
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

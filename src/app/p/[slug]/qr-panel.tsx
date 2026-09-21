'use client';

import { useState, type ReactNode } from 'react';

/**
 * The QR disclosure on the public card: the code is behind a button, not open
 * on the page.
 *
 * WHY IT IS COLLAPSED. A 160px QR sitting between the contacts and the call to
 * action is the loudest thing on a card whose point is the person — the owner
 * reads it as clutter, and it pushed the primary action further down a phone
 * screen. The card still SELLS the QR (the "QR for this card" download link next
 * to the vCard button is untouched and always visible); this only stops the code
 * itself from being shown before anyone asked for it.
 *
 * WHY THE PANEL IS ALWAYS IN THE DOM, hidden with a CLASS and not the `hidden`
 * ATTRIBUTE. Two traps, both measured rather than assumed:
 *   1. `hidden` the attribute is unusable here: Tailwind's preflight hides
 *      `[hidden]` with `display: none !important`, so no `@media print` rule
 *      could bring the code back and a printed card would lose its QR — the one
 *      place a QR is most useful. The collapsed state is therefore the `hidden`
 *      UTILITY class (plain `display: none`), which the print block in
 *      src/app/globals.css overrides.
 *   2. The region is never unmounted: `aria-controls` is an id reference, and a
 *      conditionally rendered body would leave the button pointing at an id that
 *      does not exist whenever it is collapsed — a dangling reference is exactly
 *      the kind of thing axe fails a gate on.
 *
 * WHY `display: none` IS THE CORRECT HIDING. It is the only mechanism that takes
 * the code out of the accessibility tree as well as off the screen: a visually
 * collapsed but still-exposed panel would announce "QR for this card, image" to
 * a screen reader with nothing to act on (a hidden-content trap). Collapsed
 * therefore means genuinely absent to assistive tech, expanded means present —
 * which is what the e2e test asserts against the real tree, both ways.
 *
 * Keyboard behaviour is the button's own: it is a real `<button>` (never a div
 * with a click handler), so Tab reaches it, Enter and Space toggle it, and focus
 * stays on it while the panel below changes. `aria-expanded` carries the state
 * and the visible label flips between the two dictionary strings, so both a
 * sighted and a screen-reader user can tell what the next press will do.
 *
 * 44px comes from `.btn-light` (min-h-11), the same control the card already
 * uses for vCard — no new size or focus style is invented here, and the global
 * `:focus-visible` outline in globals.css is what makes the focus ring visible.
 */
export function QrPanel({
  testId,
  showLabel,
  hideLabel,
  children,
}: {
  /** Names the button test id; the body's id is derived from it, as the card's
   *  chip sections derive their heading ids, so the pair cannot fall out of sync. */
  testId: string;
  /** Label while the code is hidden ("Show QR"). */
  showLabel: string;
  /** Label while the code is shown ("Hide QR"). */
  hideLabel: string;
  /** The card's QR image, rendered on the server and passed through. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = `${testId}-body`;
  return (
    <div>
      <button
        type="button"
        className="btn-light no-print"
        data-testid={testId}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? hideLabel : showLabel}
      </button>
      <div
        id={bodyId}
        data-testid={bodyId}
        data-qr-body
        className={open ? 'mt-3' : 'hidden'}
      >
        {children}
      </div>
    </div>
  );
}

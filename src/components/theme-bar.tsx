'use client';

import { useState } from 'react';
import { THEMES, type Theme } from '../lib/theme';
import { fill } from './fill';

/**
 * The design-review bar.
 *
 * WHERE IT SITS, AND WHY NOT FIXED. It is rendered by the root layout AFTER
 * `{children}`, in normal flow at the end of the document — never `fixed` or
 * `sticky`. The owner judges this on a phone, and both of those would put the bar
 * on top of, or hard against, the very thing being judged: the card's
 * intro/sign-in action and the event's join button are the LAST thing in their
 * cards, so a bottom-anchored bar would cover exactly the primary action, and a
 * top-anchored one would eat the first screen. In flow at the end it can do
 * neither: nothing above it moves, and the first screen is byte-for-byte the page
 * a visitor gets. The cost is honest and small — on a long card the bar is below
 * the fold, so a reviewer scrolls to the end to switch theme.
 *
 * It exists only while the theme is EXPLICIT (src/lib/theme-page.ts): a stranger
 * opening a shared card sees today's page, with no bar to explain.
 */
export function ThemeBar({
  current,
  labels,
}: {
  current: Theme;
  labels: {
    title: string;
    group: string;
    option: string;
    hint: string;
    exit: string;
    /** One label per theme, keyed by the theme itself. */
    names: Record<Theme, string>;
  };
}) {
  const [busy, setBusy] = useState(false);

  /** `null` leaves review mode: POST /api/theme clears the cookie. */
  const choose = async (theme: Theme | null) => {
    if (busy || theme === current) return;
    setBusy(true);
    try {
      const res = await fetch('/api/theme', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ theme }),
      });
      if (res.ok) {
        // The reload URL must DROP the `?theme=` parameter, and this is not
        // cosmetic: the query override outranks the cookie by design
        // (src/lib/theme.ts), so reloading `?theme=swiss` after choosing Poster
        // would re-apply swiss and make the switcher look broken — and "Exit
        // review" would re-enter review mode as it reloaded. `replace` keeps the
        // reviewer's back button out of it, one history entry per visit.
        const url = new URL(window.location.href);
        url.searchParams.delete('theme');
        window.location.replace(url.toString());
        return;
      }
    } catch {
      // fall through: keep busy=false so the reviewer can retry
    }
    setBusy(false);
  };

  return (
    // A labelled <section> so the bar is a landmark of its own: an axe scan
    // reports an un-landmarked strip of controls at the end of the document as
    // `region` (moderate) — the content is real, so it gets a region rather than
    // an exemption. `<section>` + aria-label is a landmark; a bare <div> is not.
    <section aria-label={labels.title} className="no-print border-t border-line bg-paper" data-testid="theme-bar">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-2 gap-y-1 px-5 py-3 sm:px-7">
        <span className="eyebrow mr-1">{labels.title}</span>
        <div
          role="group"
          aria-label={labels.group}
          className="flex flex-wrap items-center gap-1"
          data-testid="theme-switcher"
        >
          {THEMES.map((theme) => (
            <button
              key={theme}
              type="button"
              onClick={() => void choose(theme)}
              disabled={busy}
              aria-pressed={current === theme}
              aria-label={fill(labels.option, { name: labels.names[theme] })}
              data-testid={`theme-option-${theme}`}
              className={
                // min-h-11: the 44px touch target the rest of the app holds to.
                'inline-flex min-h-11 items-center rounded-lg px-3 text-xs font-bold uppercase tracking-wide transition-colors ' +
                (current === theme ? 'bg-ink text-white' : 'text-muted hover:bg-white hover:text-ink')
              }
            >
              {labels.names[theme]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void choose(null)}
          disabled={busy}
          data-testid="theme-exit"
          className="inline-flex min-h-11 items-center rounded-lg border border-line-strong px-3 text-xs font-bold uppercase tracking-wide text-ink transition-colors hover:bg-white"
        >
          {labels.exit}
        </button>
        <p className="text-[11px] text-muted sm:flex-1" data-testid="theme-hint">
          {labels.hint}
        </p>
      </div>
    </section>
  );
}

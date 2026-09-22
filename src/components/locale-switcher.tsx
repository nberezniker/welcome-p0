'use client';

import { useState } from 'react';

/**
 * Locale switcher: POSTs /api/locale, then does a full reload so every server
 * component re-renders with the new cookie (router.refresh() proved flaky on a
 * cold dev server; a reload is deterministic and keeps the URL unchanged).
 */
export function LocaleSwitcher({
  current,
  ariaLabel,
}: {
  current: string;
  ariaLabel: string;
}) {
  const [busy, setBusy] = useState(false);

  const setLocale = async (locale: string) => {
    if (locale === current || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/locale', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale }),
      });
      if (res.ok) {
        window.location.reload();
        return;
      }
    } catch {
      // fall through: keep busy=false so the user can retry
    }
    setBusy(false);
  };

  return (
    <div role="group" aria-label={ariaLabel} className="flex items-center gap-1" data-testid="locale-switcher">
      {['en', 'ru', 'es'].map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => void setLocale(code)}
          disabled={busy}
          aria-pressed={current === code}
          aria-label={ariaLabel + ': ' + code.toUpperCase()}
          className={
            // The current language is a LIGHT FIELD with a hairline, not a solid
            // dark pill: it sits in the header, directly above the page's own
            // primary action, and a second dark block at that size reads as a
            // competitor to it (the landing's CTA is the one accented control on
            // the first screen). `aria-pressed` still states which one is on, so
            // the difference does not rest on colour alone.
            // min-h-11 + min-w-11: a two-letter label is a 44x44 touch target.
            'inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2 text-xs font-bold uppercase transition-colors ' +
            (current === code
              ? 'border border-line bg-white text-ink'
              : 'border border-transparent text-muted hover:bg-white hover:text-ink')
          }
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

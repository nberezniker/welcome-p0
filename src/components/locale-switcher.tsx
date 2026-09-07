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
            'rounded-lg px-2.5 py-1.5 text-xs font-bold uppercase transition-colors ' +
            (current === code ? 'bg-ink text-white' : 'text-muted hover:bg-white hover:text-ink')
          }
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

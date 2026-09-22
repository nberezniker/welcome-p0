'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { DEFAULT_LOCALE, type Locale } from '../i18n/locale';
import { readClientLocale, surfaceCopy } from '../i18n/surface-copy';

/**
 * The body of a crash page, shared by the segment boundary (src/app/error.tsx)
 * and the last-resort one (src/app/global-error.tsx) so the two can never drift
 * into two different-looking failures.
 *
 * Renders NOTHING about the failure itself. No stack, no path, no digest, no
 * job id, no request id: a person looking at a broken page cannot act on any of
 * those, and a digested error message can still quote a value that belongs to
 * somebody else. The digest goes to the log (`log.error` in the two callers),
 * where an operator can join it to the server-side trace; the reader gets a
 * sentence they can act on and two ways out.
 *
 * Accessibility: the heading is a real `<h1>` and takes focus once, so a screen
 * reader announces the failure instead of leaving focus on a button that no
 * longer exists, and the keyboard user is not dropped at the top of a page whose
 * content they cannot see. `lang` comes from the document (the root layout for
 * the segment boundary; global-error sets its own `<html lang>`), which is why
 * the locale is resolved in an effect rather than during render: the first
 * render must match the server's or React reports a hydration mismatch.
 */
/**
 * The locale of the document a crash happened on.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`, and rather than a
 * plain function call: this value only exists in the browser, so it has to be
 * read after the server render without ever disagreeing with it. The hook is
 * built for exactly that shape — React reads the SERVER snapshot while
 * server-rendering AND while hydrating, then re-renders from the client snapshot
 * if the two differ, which is a supported transition rather than a hydration
 * mismatch. A `setState` inside an effect would do the same thing by hand (and
 * is what the react-hooks rule in this repo forbids); resolving during render
 * would read `document` on the server and break the render outright.
 *
 * The store never changes: the language of a page cannot change while a crash
 * page is on screen (the switcher lives in the layout that just failed), so the
 * subscription is a no-op and `readClientLocale` — a module-level function — is a
 * stable snapshot.
 */
export function useSurfaceLocale(): Locale {
  return useSyncExternalStore(
    subscribeToNothing,
    readClientLocale,
    serverLocale,
  );
}

function subscribeToNothing(): () => void {
  return () => {};
}

function serverLocale(): Locale {
  return DEFAULT_LOCALE;
}

export function ErrorSurface({ onRetry }: { onRetry?: () => void }) {
  const locale = useSurfaceLocale();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const copy = surfaceCopy(locale);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-xl flex-col items-center justify-center px-5 py-16 text-center sm:px-7">
      <span aria-hidden="true" className="grid size-11 -rotate-6 place-items-center rounded-xl bg-ink text-xl font-extrabold text-white">
        W
      </span>
      <h1
        ref={headingRef}
        tabIndex={-1}
        // `focus-target-quiet` on a programmatic focus target only: the element
        // is not reachable by Tab, so there is no focus ring to remove, and a
        // visible ring on a heading nobody tabbed to reads as a stray artifact.
        // NOT `outline-none`: that utility loses to the unlayered
        // `:focus-visible` rule in globals.css, so the ring used to appear or not
        // depending on whether the reader had last pressed a key — measured as
        // 3/3 keyboard against 0/3 pointer (globals.css carries the rule and why).
        className="focus-target-quiet mt-5 text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl"
      >
        {copy.title}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">{copy.text}</p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        {onRetry ? (
          <button type="button" onClick={onRetry} className="btn-primary">
            {copy.retry}
          </button>
        ) : null}
        <Link href="/" className="btn-outline">
          {copy.home}
        </Link>
      </div>
    </div>
  );
}

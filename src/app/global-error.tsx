'use client';

import { useEffect } from 'react';
import { log } from '../lib/logger';
import { ErrorSurface, useSurfaceLocale } from '../components/error-surface';

/**
 * The last resort: a React error boundary that replaces the ROOT LAYOUT, which
 * is the one failure src/app/error.tsx cannot catch (it wraps the segments
 * INSIDE app/layout.tsx). Next requires this file to bring its own `<html>` and
 * `<body>`, so that is exactly what it does — and it is why the locale has to be
 * resolved in the browser (src/i18n/surface-copy.ts `readClientLocale`) instead
 * of from the request: there is no request left to read.
 *
 * Its own document, so `lang` is set here rather than inherited. Two honest
 * limits, both recorded in `readClientLocale`: the first render is English and
 * the real value arrives in an effect (a hydration mismatch would be a second
 * failure inside the failure), and a visitor who never chose a language and
 * whose ACCOUNT is not English falls back to English.
 *
 * Like the segment boundary, nothing about the error reaches the page: the
 * digest goes to the log, the reader gets a sentence and two ways out.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = useSurfaceLocale();

  useEffect(() => {
    log.error('[client_error] root layout failed', {
      event: 'global_client_error',
      code: error.digest ?? 'no_digest',
      err: error,
    });
  }, [error]);

  return (
    <html lang={locale}>
      {/* Same body classes as the root layout (src/app/layout.tsx) so the styled
          case is indistinguishable from a normal page. The stylesheet is the
          document's own — this boundary never renders inside a fresh document
          that lacked one, so it does not re-import globals.css. */}
      <body className="min-h-screen antialiased">
        <ErrorSurface onRetry={reset} />
      </body>
    </html>
  );
}

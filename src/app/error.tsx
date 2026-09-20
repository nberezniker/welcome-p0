'use client';

import { useEffect } from 'react';
import { log } from '../lib/logger';
import { ErrorSurface } from '../components/error-surface';

/**
 * Error boundary for every segment below the root layout: a render error in a
 * page or one of its children lands here instead of replacing the whole shell,
 * so the signed-in chrome (and, for a public page, the site header) survives and
 * the reader keeps a way out.
 *
 * WHAT IS LOGGED, AND WHERE. `error.digest` is the id Next also prints
 * server-side for this same failure; logging it here means a client-side render
 * error still produces a line an operator can grep for, which is the difference
 * between "the user saw a crash page" and "the user saw a crash page, and here
 * is what threw". The digest alone is not enough to identify anything sensitive,
 * and it is NOT rendered — see src/components/error-surface.tsx.
 *
 * Note the asymmetry with the server: a page that throws during SSR is reported
 * by Next itself and again by src/lib/http.ts `internalError` for API routes,
 * so this file covers the failures those two never see (rebuilds after a state
 * update, a throwing client child).
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    log.error('[client_error] segment render failed', {
      event: 'client_error',
      code: error.digest ?? 'no_digest',
      err: error,
    });
  }, [error]);

  return <ErrorSurface onRetry={reset} />;
}

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAccountIdByToken, SESSION_COOKIE } from './auth';

/** Optional session for server components: null when signed out. */
export async function getOptionalAccountId(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getAccountIdByToken(token);
}

/**
 * Optional session for server components, TOLERANT OF BEING RENDERED OUTSIDE A
 * REQUEST SCOPE.
 *
 * `getOptionalAccountId` above calls `cookies()`, which throws when a page is
 * rendered without a request (component-level tests render pages directly — the
 * same situation `getLocale()` handles in src/i18n/index.ts by falling back to
 * the default). The fallback here is `null`, i.e. "no session we can see", which
 * is the honest answer in both cases: outside a request there is no cookie jar,
 * and the caller must render the signed-out state.
 *
 * Protected pages must keep using `requireAccountId` — this is for components
 * that render usefully without a session as well.
 */
export async function getOptionalAccountIdForRender(): Promise<string | null> {
  try {
    return await getOptionalAccountId();
  } catch {
    return null;
  }
}

/**
 * Auth gate for protected pages (NFR: server-side check, no client trust).
 * Redirects to /login (with a same-origin `next` path when given).
 */
export async function requireAccountId(nextPath?: string): Promise<string> {
  const accountId = await getOptionalAccountId();
  if (!accountId) {
    const safeNext = nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : null;
    redirect(safeNext ? `/login?next=${encodeURIComponent(safeNext)}` : '/login');
  }
  return accountId;
}

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

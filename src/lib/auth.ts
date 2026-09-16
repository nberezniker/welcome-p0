import { NextRequest, NextResponse } from 'next/server';
import type { TransactionSql } from 'postgres';
import { getSql } from './db';
import { generateSessionToken, hashSessionToken } from './crypto';
import { isProduction } from './env';
import { isLocale, type Locale } from '../i18n/locale';

export const SESSION_COOKIE = 'welcome_session';
export const SESSION_TTL_DAYS = 30;
/** Refresh when less than this many days remain (sliding expiry, ~1 write/day max). */
const REFRESH_THRESHOLD_DAYS = 29;
/** last_seen_at is a "still in use" signal, not a request log: at most one
 * write per session per this window, so a busy client costs ~1 row write/hour. */
const LAST_SEEN_THROTTLE_MINUTES = 5;

export interface AuthContext {
  accountId: string;
  accountStatus: string;
  sessionId: string;
  /** When the session last passed MFA (F-03); NULL = never verified in this session. */
  mfaVerifiedAt: Date | null;
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/** Creates a session row. Only the SHA-256 hash of the token is stored.
 * Pass `tx` to create it atomically with the surrounding transaction. */
export async function createSession(accountId: string, tx?: TransactionSql): Promise<IssuedSession> {
  const sql = tx ?? getSql();
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const rows = await sql<{ expires_at: Date }[]>`
    INSERT INTO sessions (account_id, token_hash, expires_at)
    VALUES (${accountId}, ${tokenHash}, now() + (${SESSION_TTL_DAYS} * interval '1 day'))
    RETURNING expires_at
  `;
  const row = rows[0];
  if (!row) throw new Error('session insert returned no row');
  return { token, expiresAt: new Date(row.expires_at) };
}

/** Deletes the session row for a raw token (logout). */
export async function destroySession(token: string): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM sessions WHERE token_hash = ${hashSessionToken(token)}`;
}

/**
 * Server-side session validation for route handlers / server components.
 * Returns null when the cookie is missing, the session is expired/unknown,
 * or the account is not active. Applies sliding refresh (30-day TTL).
 */
export async function requireAccount(req: NextRequest): Promise<AuthContext | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = hashSessionToken(token);

  const sql = getSql();
  const rows = await sql<{ session_id: string; expires_at: Date; account_id: string; account_status: string; mfa_verified_at: Date | null }[]>`
    SELECT s.id AS session_id, s.expires_at, a.id AS account_id, a.status AS account_status, s.mfa_verified_at
    FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now()
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.account_status !== 'active') return null;

  // Sliding refresh: extend to full TTL once per day at most.
  const expiresAt = new Date(row.expires_at);
  const threshold = new Date(Date.now() + REFRESH_THRESHOLD_DAYS * 24 * 3600 * 1000);
  if (expiresAt < threshold) {
    await sql`
      UPDATE sessions
      SET expires_at = now() + (${SESSION_TTL_DAYS} * interval '1 day')
      WHERE id = ${row.session_id}
    `;
  }

  // Throttled last-seen bump (feeds the device list on /me/security). Guarded in
  // SQL so concurrent requests cannot stampede the same row.
  await sql`
    UPDATE sessions
    SET last_seen_at = now()
    WHERE id = ${row.session_id}
      AND last_seen_at < now() - (${LAST_SEEN_THROTTLE_MINUTES} * interval '1 minute')
  `;

  return { accountId: row.account_id, accountStatus: row.account_status, sessionId: row.session_id, mfaVerifiedAt: row.mfa_verified_at ? new Date(row.mfa_verified_at) : null };
}

/** Resolves the ACTIVE session (account id + session row id + the account's
 * durable language) from a raw token. Server components have no Request object
 * for requireAccount, so they resolve the cookie here; route handlers get the
 * same data from requireAccount.
 *
 * `locale` is read here rather than in a second query because this lookup
 * already joins `accounts`, and every request carrying a session needs it
 * exactly once (src/i18n/index.ts getLocale). NULL = "never chose", which is a
 * different fact from 'en'. Validated against the closed locale registry, so a
 * hand-edited column can never widen the union. */
export async function getSessionByToken(
  token: string | null | undefined,
): Promise<{ accountId: string; sessionId: string; locale: Locale | null } | null> {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const sql = getSql();
  const rows = await sql<{ session_id: string; account_id: string; account_status: string; locale: string | null }[]>`
    SELECT s.id AS session_id, s.account_id, a.status AS account_status, a.locale
    FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now()
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || row.account_status !== 'active') return null;
  return {
    accountId: row.account_id,
    sessionId: row.session_id,
    locale: isLocale(row.locale) ? row.locale : null,
  };
}

/** Resolves an active account id from a raw session token (server components —
 * page context has no Request object for requireAccount). */
export async function getAccountIdByToken(token: string | null | undefined): Promise<string | null> {
  return (await getSessionByToken(token))?.accountId ?? null;
}

/**
 * Stores the account's DURABLE language preference (migration 014).
 *
 * Called from exactly ONE place — POST /api/locale, i.e. the user pressing the
 * locale switcher. A `?lang=` query parameter never reaches this function: a URL
 * fetched by an unfurler or a scanner must not change the language of the user's
 * own account.
 *
 * `IS DISTINCT FROM` makes a repeated switch a no-op instead of a write, so
 * pressing the language you already have changes no row. `updated_at` is
 * deliberately NOT bumped either: it drives the account-deletion sweep, and a
 * language preference is not a change to the account. Returns whether a row was
 * actually written. */
export async function setAccountLocale(accountId: string, locale: Locale): Promise<boolean> {
  const rows = await getSql()`
    UPDATE accounts SET locale = ${locale}
    WHERE id = ${accountId} AND locale IS DISTINCT FROM ${locale}
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * F-03 step-up policy (ADR 0007): owner-level organizer actions require a
 * CONFIRMED MFA credential AND a session whose mfa_verified_at is fresh
 * (within MFA_STEP_UP_WINDOW_MINUTES). Accounts WITHOUT a confirmed MFA
 * factor keep the legacy behaviour — mfa_required is never raised for them.
 * Platform admins are exempt at the call sites (owner-only enforcement).
 */
export const MFA_STEP_UP_WINDOW_MINUTES = 30;

/** True when the caller may perform owner-level organizer actions right now. */
export async function requireMfaFresh(auth: Pick<AuthContext, 'accountId' | 'mfaVerifiedAt'>): Promise<boolean> {
  const sql = getSql();
  const rows = await sql<{ confirmed_at: Date | null }[]>`
    SELECT confirmed_at FROM mfa_credentials WHERE account_id = ${auth.accountId} LIMIT 1
  `;
  const cred = rows[0];
  if (!cred || cred.confirmed_at == null) return true; // MFA not enrolled — no step-up
  if (!auth.mfaVerifiedAt) return false;
  return auth.mfaVerifiedAt.getTime() > Date.now() - MFA_STEP_UP_WINDOW_MINUTES * 60_000;
}

/** Sets the HttpOnly session cookie. secure=true in production; SameSite=Lax. */
export function setSessionCookie(res: NextResponse, token: string, expiresAt: Date): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    expires: expiresAt,
  });
}

/** Clears the session cookie. */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    maxAge: 0,
  });
}

/** Extracts the welcome_session cookie value from a Set-Cookie header (test helper). */
export function extractSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const m = /welcome_session=([^;]+)/.exec(setCookieHeader);
  return m?.[1] ?? null;
}

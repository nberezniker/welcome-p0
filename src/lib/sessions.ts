import type { Sql } from 'postgres';

/**
 * Active-session listing, shared by GET /api/me/sessions (route handler) and
 * /me/security (server component) so both render the same order and shape.
 *
 * The projection is deliberately tiny: an opaque row id, two timestamps and the
 * "this device" flag. No token, no hash, no user-agent, no IP — none of those
 * are stored, so none can leak.
 */
export interface ActiveSession {
  id: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

export async function loadActiveSessions(
  sql: Sql,
  accountId: string,
  currentSessionId: string | null,
): Promise<ActiveSession[]> {
  const rows = await sql<{ id: string; created_at: Date; last_seen_at: Date; current: boolean }[]>`
    SELECT id, created_at, last_seen_at,
           (${currentSessionId}::uuid IS NOT NULL AND id = ${currentSessionId}::uuid) AS current
    FROM sessions
    WHERE account_id = ${accountId} AND expires_at > now()
    ORDER BY current DESC, last_seen_at DESC, created_at DESC, id ASC
  `;
  return rows.map((row) => ({
    id: row.id,
    created_at: new Date(row.created_at).toISOString(),
    last_seen_at: new Date(row.last_seen_at).toISOString(),
    current: row.current,
  }));
}

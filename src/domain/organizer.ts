import type { Sql, TransactionSql } from 'postgres';

/** Organizer role resolution. Server-side only: roles come from organizer_members,
 * NEVER from request bodies or query params. */

export type OrganizerRole = 'owner' | 'admin' | 'staff';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface EventRoleContext {
  eventId: string;
  organizerId: string;
  role: OrganizerRole;
}

/**
 * Resolves the caller's role on an event, or null when absent/insufficient.
 * `roles` is the allowlist for the operation (e.g. ['owner','admin']).
 */
export async function requireEventRole(
  sql: Sql | TransactionSql,
  accountId: string,
  eventId: string,
  roles: readonly OrganizerRole[],
): Promise<EventRoleContext | null> {
  if (!isUuid(eventId) || !isUuid(accountId)) return null;
  const rows = await sql<{ role: OrganizerRole; organizer_id: string }[]>`
    SELECT om.role, e.organizer_id
    FROM events e
    JOIN organizer_members om ON om.organizer_id = e.organizer_id
    WHERE e.id = ${eventId} AND om.account_id = ${accountId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || !roles.includes(row.role)) return null;
  return { eventId, organizerId: row.organizer_id, role: row.role };
}

/**
 * Returns the organizer where the account is owner, creating one on first use.
 * Does NOT grant extra roles on existing organizers. Race-safe: the partial
 * unique index organizer_members_owner_uq backs the "one owner-organizer"
 * invariant; a lost race re-reads the winner.
 */
export async function ensureOrganizerForAccount(
  sql: Sql | TransactionSql,
  accountId: string,
  displayName: string,
): Promise<string> {
  const readOwner = async (): Promise<string | null> => {
    const rows = await sql<{ id: string }[]>`
      SELECT o.id
      FROM organizers o
      JOIN organizer_members om ON om.organizer_id = o.id
      WHERE om.account_id = ${accountId} AND om.role = 'owner'
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await readOwner();
    if (existing) return existing;
    try {
      if ('begin' in sql) {
        // Pool connection: create atomically in our own transaction.
        return await sql.begin(async (tx): Promise<string> => {
          const created = await tx<{ id: string }[]>`
            INSERT INTO organizers (display_name) VALUES (${displayName}) RETURNING id
          `;
          const organizerId = created[0]!.id;
          await tx`
            INSERT INTO organizer_members (organizer_id, account_id, role)
            VALUES (${organizerId}, ${accountId}, 'owner')
          `;
          return organizerId;
        });
      }
      // Caller's transaction: participate in it directly (no nested begin).
      const created = await sql<{ id: string }[]>`
        INSERT INTO organizers (display_name) VALUES (${displayName}) RETURNING id
      `;
      const organizerId = created[0]!.id;
      await sql`
        INSERT INTO organizer_members (organizer_id, account_id, role)
        VALUES (${organizerId}, ${accountId}, 'owner')
      `;
      return organizerId;
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 2) throw err;
      // Concurrent first-create won the unique index; fall through and re-read.
    }
  }
  const fallback = await readOwner();
  if (!fallback) throw new Error('ensureOrganizerForAccount failed');
  return fallback;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

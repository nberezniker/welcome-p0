import type { Sql, TransactionSql } from 'postgres';
import { getSql } from './db';

/** Audit helper: appends to the append-only audit_events table.
 * Never store tokens, raw contact values or private message bodies here. */

type SqlLike = Sql | TransactionSql;
type JsonParam = Parameters<Sql['json']>[0];

export async function recordAudit(
  sqlOrTx: SqlLike | undefined,
  actorAccountId: string | null,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const sql = sqlOrTx ?? getSql();
  await sql`
    INSERT INTO audit_events (actor_account_id, action, target_type, target_id, metadata)
    VALUES (${actorAccountId}, ${action}, ${targetType}, ${targetId}, ${sql.json(metadata as JsonParam)})
  `;
}

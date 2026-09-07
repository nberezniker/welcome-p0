import type { Sql, TransactionSql } from 'postgres';

/** DB-count rate limiting — the same pattern as the OTP request throttle
 * (count rows created for a subject within a sliding window). No extra table:
 * the business table itself is the counter (every checked action inserts a row
 * with created_at). */

type SqlLike = Sql | TransactionSql;

export interface RateLimitSpec {
  /** Business table used as the counter (code-controlled identifier). */
  table: string;
  /** Subject column, e.g. account_id / event_id / organizer_id. */
  subjectColumn: string;
  subjectId: string;
  windowMinutes: number;
  max: number;
}

export interface RateLimitResult {
  limited: boolean;
  current: number;
  retryAfterSeconds: number;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** Evaluates the rate limit for a subject. Routes turn `limited` into a 429. */
export async function checkRateLimit(sql: SqlLike, spec: RateLimitSpec): Promise<RateLimitResult> {
  // Identifiers are code-controlled; reject anything that is not a plain name
  // instead of interpolating it into the query.
  if (!IDENT_RE.test(spec.table) || !IDENT_RE.test(spec.subjectColumn)) {
    throw new Error('rate limit table/column must be plain lowercase identifiers');
  }
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM ${sql(spec.table)}
    WHERE ${sql(spec.subjectColumn)} = ${spec.subjectId}
      AND created_at > now() - (${spec.windowMinutes} * interval '1 minute')
  `;
  const current = rows[0]?.count ?? 0;
  return {
    limited: current >= spec.max,
    current,
    retryAfterSeconds: spec.windowMinutes * 60,
  };
}

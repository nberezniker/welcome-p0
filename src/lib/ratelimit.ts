import type { Sql, TransactionSql } from 'postgres';
import type { NextRequest } from 'next/server';

/** Rate limiting primitives.
 *
 * 1. DB-count limiting (checkRateLimit below) — the same pattern as the OTP
 *    request throttle (count rows created for a subject within a sliding
 *    window). No extra table: the business table itself is the counter.
 *
 * 2. In-memory per-IP token buckets (takeFromBucket/consumeIpToken) for the
 *    generic sensitive-route table. Single-process by design for P0
 *    (documented limitation, ADR 0005): state dies with the process and is
 *    not shared across instances.
 */

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

// ---------------------------------------------------------------------------
// In-memory per-IP token buckets (generic, route-scoped).
// ---------------------------------------------------------------------------

export interface TokenBucketOptions {
  capacity: number;
  windowMs: number;
}

export interface TokenBucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface TokenVerdict {
  allowed: boolean;
  /** Tokens left after the take (0 when denied). */
  remaining: number;
  /** Ms until one token is available again (0 when allowed). */
  retryAfterMs: number;
  nowMs: number;
}

export interface TokenTakeResult extends TokenVerdict {
  state: TokenBucketState;
}

/**
 * Pure token-bucket step (unit-tested with an injected clock): refills at
 * `capacity / windowMs` tokens per ms up to capacity, then consumes one.
 * An absent state starts as a full bucket.
 */
export function takeFromBucket(
  state: TokenBucketState | undefined,
  nowMs: number,
  opts: TokenBucketOptions,
): TokenTakeResult {
  const rate = opts.capacity / opts.windowMs;
  const prevTokens = state?.tokens ?? opts.capacity;
  const last = state?.lastRefillMs ?? nowMs;
  const elapsed = Math.max(0, nowMs - last);
  const tokens = Math.min(opts.capacity, prevTokens + elapsed * rate);

  if (tokens >= 1) {
    return {
      allowed: true,
      remaining: Math.floor(tokens - 1),
      retryAfterMs: 0,
      nowMs,
      state: { tokens: tokens - 1, lastRefillMs: nowMs },
    };
  }
  return {
    allowed: false,
    remaining: 0,
    retryAfterMs: (1 - tokens) / rate,
    nowMs,
    state: { tokens, lastRefillMs: nowMs },
  };
}

const buckets = new Map<string, TokenBucketState>();
/** Memory bound for the single-process map; stale entries are pruned past it. */
const MAX_BUCKETS = 50_000;

let clock: () => number = () => Date.now();

/** Test hook: injects a deterministic clock for bucket refill. */
export function setRateLimitClock(fn: () => number): void {
  clock = fn;
}

/** Best-effort client IP: first X-Forwarded-For hop, then X-Real-IP, else 'unknown'. */
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  const first = fwd?.split(',')[0]?.trim();
  if (first) return first;
  return req.headers.get('x-real-ip') ?? 'unknown';
}

/** Consumes one token from the (route, ip) bucket. */
export function consumeIpToken(ip: string, routeKey: string, opts: TokenBucketOptions): TokenVerdict {
  const nowMs = clock();
  if (buckets.size > MAX_BUCKETS) {
    for (const [key, state] of buckets) {
      if (nowMs - state.lastRefillMs > opts.windowMs) buckets.delete(key);
    }
  }
  const verdict = takeFromBucket(buckets.get(`${routeKey}:${ip}`), nowMs, opts);
  buckets.set(`${routeKey}:${ip}`, verdict.state);
  return verdict;
}

/** Test hook: clears all buckets. */
export function resetIpBuckets(): void {
  buckets.clear();
}

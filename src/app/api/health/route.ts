import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '../../../lib/db';
import { secureSecretEqual } from '../../../lib/crypto';

export const dynamic = 'force-dynamic';

/** Latest migration version that must be recorded in schema_migrations. */
const EXPECTED_MIGRATIONS = ['001'];
const WORKER_FRESHNESS_SECONDS = 60;

/** Outbox statuses that are NOT terminal (spec 04 §7): a job in one of these has
 * not been handed over / given up on yet, so its created_at is delivery lag. */
const NON_TERMINAL_OUTBOX_STATUSES = ['pending', 'leased'] as const;

/** Public payload (F-16): no stack-layout details, no migration version —
 * exactly what uptime monitors need.
 *
 * `pending_jobs` / `oldest_pending_job_age_seconds` are the one addition since
 * F-16, and they are aggregates of WORK, not of infrastructure: how many
 * non-terminal outbox jobs exist and how old the oldest one is. They carry no
 * job id, kind, channel, recipient or payload, so unlike `migration_version`
 * they are not a deployment fingerprint — they are the number a monitor needs to
 * say "the queue is not draining". */
interface PublicHealthPayload {
  status: 'ok' | 'error';
  db: 'up' | 'down';
  worker: 'up' | 'down';
  pending_jobs: number;
  oldest_pending_job_age_seconds: number | null;
}

/** Detailed payload — only for callers presenting the shared worker secret. */
interface DetailedHealthPayload extends PublicHealthPayload {
  migrations: 'applied' | 'missing';
  migration_version: string | null;
}

/**
 * Health check: DB read, DB write (real worker_heartbeat beat update), applied
 * migrations, worker heartbeat freshness, and outbox delivery lag. Returns 200
 * only when the DB is up and migrations are applied; worker status is reported
 * separately.
 * F-16: `migration_version` is no longer public — it is included ONLY when the
 * request carries `x-health-details: <WORKER_TICK_SECRET>` (constant-time
 * compare; unset secret → details are never exposed).
 */
export async function GET(req: NextRequest) {
  const sql = getSql();
  let db: 'up' | 'down' = 'down';
  let migrations: 'applied' | 'missing' = 'missing';
  let migrationVersion: string | null = null;
  let worker: 'up' | 'down' = 'down';
  let pendingJobs = 0;
  let oldestPendingJobAgeSeconds: number | null = null;

  try {
    // 1. DB read
    await sql`SELECT 1`;
    db = 'up';

    // 2. DB write — real beat update (proves write access, keeps heartbeat fresh)
    await sql`
      INSERT INTO worker_heartbeat (id, beat_at) VALUES (true, now())
      ON CONFLICT (id) DO UPDATE SET beat_at = now()
    `;

    // 3. Applied migrations
    const applied = await sql<{ version: string }[]>`SELECT version FROM schema_migrations`;
    const appliedVersions = new Set(applied.map((r) => r.version));
    const allApplied = EXPECTED_MIGRATIONS.every((v) => appliedVersions.has(v));
    migrations = allApplied ? 'applied' : 'missing';
    migrationVersion = appliedVersions.size > 0 ? [...appliedVersions].sort().pop() ?? null : null;

    // 4. Worker heartbeat freshness
    const beats = await sql<{ beat_at: Date | null }[]>`SELECT beat_at FROM worker_heartbeat WHERE id = true`;
    const beatAt = beats[0]?.beat_at;
    if (beatAt) {
      const ageMs = Date.now() - new Date(beatAt).getTime();
      worker = ageMs >= 0 && ageMs <= WORKER_FRESHNESS_SECONDS * 1000 ? 'up' : 'down';
    }

    // 5. Outbox delivery lag — one read-only aggregate over the non-terminal
    //    rows (outbox_ready_idx covers status). `min(created_at)` of an empty
    //    queue is NULL, which is exactly the honest answer: no lag.
    //
    //    Deliberately in its own try: this is a METRIC, and a metric must never
    //    be able to turn a healthy deployment into a 503. A failure here is
    //    reported (loudly, to the server log — the payload just has no number)
    //    while liveness keeps its own, independent verdict.
    try {
      const lag = await sql<{ pending: number; oldest_age_seconds: number | null }[]>`
        SELECT count(*)::int AS pending,
               EXTRACT(EPOCH FROM now() - min(created_at))::int AS oldest_age_seconds
        FROM outbox_jobs
        WHERE status IN ${sql([...NON_TERMINAL_OUTBOX_STATUSES])}
      `;
      pendingJobs = lag[0]?.pending ?? 0;
      oldestPendingJobAgeSeconds = lag[0]?.oldest_age_seconds ?? null;
    } catch (err) {
      console.warn('[health] outbox lag unavailable (liveness is unaffected):', err);
    }
  } catch (err) {
    console.error('[health] check failed', err);
  }

  const status: PublicHealthPayload['status'] = db === 'up' && migrations === 'applied' ? 'ok' : 'error';

  const secret = process.env.WORKER_TICK_SECRET;
  const detailsAuthorized =
    !!secret && secureSecretEqual(req.headers.get('x-health-details') ?? '', secret);

  const payload: PublicHealthPayload | DetailedHealthPayload = detailsAuthorized
    ? {
        status,
        db,
        migrations,
        migration_version: migrationVersion,
        worker,
        pending_jobs: pendingJobs,
        oldest_pending_job_age_seconds: oldestPendingJobAgeSeconds,
      }
    : {
        status,
        db,
        worker,
        pending_jobs: pendingJobs,
        oldest_pending_job_age_seconds: oldestPendingJobAgeSeconds,
      };

  return NextResponse.json(payload, {
    status: status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}

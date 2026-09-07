import { NextResponse } from 'next/server';
import { getSql } from '../../../lib/db';

export const dynamic = 'force-dynamic';

/** Latest migration version that must be recorded in schema_migrations. */
const EXPECTED_MIGRATIONS = ['001'];
const WORKER_FRESHNESS_SECONDS = 60;

interface HealthPayload {
  status: 'ok' | 'error';
  db: 'up' | 'down';
  migrations: 'applied' | 'missing';
  migration_version: string | null;
  worker: 'up' | 'down';
}

/**
 * Health check: DB read, DB write (real worker_heartbeat beat update), applied
 * migrations, and worker heartbeat freshness. Returns 200 only when the DB is
 * up and migrations are applied; worker status is reported separately.
 * Until the dedicated worker ships (later phase), this endpoint's beat update
 * is the heartbeat source.
 */
export async function GET() {
  const sql = getSql();
  let db: 'up' | 'down' = 'down';
  let migrations: 'applied' | 'missing' = 'missing';
  let migrationVersion: string | null = null;
  let worker: 'up' | 'down' = 'down';

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
  } catch (err) {
    console.error('[health] check failed', err);
  }

  const status: HealthPayload['status'] = db === 'up' && migrations === 'applied' ? 'ok' : 'error';
  const payload: HealthPayload = {
    status,
    db,
    migrations,
    migration_version: migrationVersion,
    worker,
  };
  return NextResponse.json(payload, {
    status: status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}

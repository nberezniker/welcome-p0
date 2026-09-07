#!/usr/bin/env node
// Outbox admin tooling — explicit, operator-driven only.
// Verbs:
//   stats              → per-status counters for outbox_jobs
//   requeue <jobId>    → explicit re-queue of a stuck/failed job (NEVER automatic)
//   suppress <jobId>   → suppress a pending/leased job
// There is NO automatic dead-letter resend (spec 04 §7: retry only explicitly controlled).
// Usage: node --env-file-if-exists=.env.local --import tsx scripts/outbox-admin.mts <verb> [jobId]
import { getSql, closeSql } from '../src/lib/db.ts';
import { isProduction } from '../src/lib/env.ts';
import { OUTBOX_STATUSES, type OutboxStatus } from '../src/infra/outbox.ts';

const [verb, jobId] = process.argv.slice(2);

if (isProduction() && process.env.OUTBOX_ADMIN_CONFIRM !== 'yes') {
  console.error('REFUSED: outbox-admin in production requires OUTBOX_ADMIN_CONFIRM=yes');
  process.exit(1);
}

const sql = getSql();

async function main(): Promise<number> {
  if (verb === 'stats') {
    const byStatus = await sql<{ status: OutboxStatus; count: number }[]>`
      SELECT status, count(*)::int AS count FROM outbox_jobs GROUP BY status ORDER BY status
    `;
    const counts = new Map(byStatus.map((r) => [r.status, r.count]));
    for (const s of OUTBOX_STATUSES) {
      console.log(`${s.padEnd(11)} ${counts.get(s) ?? 0}`);
    }
    const recent = await sql<{ id: string; kind: string; status: string; attempt: number; created_at: Date }[]>`
      SELECT id, kind, status, attempt, created_at FROM outbox_jobs ORDER BY created_at DESC LIMIT 10
    `;
    console.log('\nmost recent 10:');
    for (const r of recent) {
      console.log(`  ${r.id} ${r.kind} ${r.status} attempt=${r.attempt} ${r.created_at.toISOString()}`);
    }
    return 0;
  }

  if (verb === 'requeue' || verb === 'suppress') {
    if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) {
      console.error(`usage: outbox-admin ${verb} <jobId-uuid>`);
      return 1;
    }
    if (verb === 'requeue') {
      const rows = await sql<{ id: string; status: string }[]>`
        UPDATE outbox_jobs
        SET status = 'pending', due_at = now(), lease_until = NULL
        WHERE id = ${jobId} AND status IN ('failed', 'unknown', 'suppressed', 'cancelled', 'leased')
        RETURNING id, status
      `;
      if (!rows[0]) {
        console.error(`job ${jobId}: nothing requeued (not found or already pending/sent)`);
        return 1;
      }
      console.log(`job ${rows[0].id}: requeued (was ${rows[0].status})`);
      return 0;
    }
    const rows = await sql<{ id: string }[]>`
      UPDATE outbox_jobs SET status = 'suppressed', lease_until = NULL
      WHERE id = ${jobId} AND status IN ('pending', 'leased')
      RETURNING id
    `;
    if (!rows[0]) {
      console.error(`job ${jobId}: nothing suppressed (not found or not pending/leased)`);
      return 1;
    }
    console.log(`job ${rows[0].id}: suppressed`);
    return 0;
  }

  console.error('usage: outbox-admin <stats | requeue <jobId> | suppress <jobId>>');
  return 1;
}

main()
  .then((code) => process.exitCode = code)
  .catch((err) => {
    console.error('outbox-admin failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeSql());

#!/usr/bin/env node
// WELCOME outbox worker: leases outbox_jobs and delivers via the selected
// channel transport. Runs until SIGTERM (graceful drain).
// Run: pnpm worker   (= node --env-file-if-exists=.env.local --import tsx scripts/worker.mts)
import { runWorker } from '../src/infra/worker.ts';
import { isProduction } from '../src/lib/env.ts';

if (isProduction() && !process.env.TELEGRAM_BOT_TOKEN) {
  // Production MUST have real credentials: the disabled transport would fail
  // every job. Fail loudly at startup instead of burning jobs into 'failed'.
  console.error('REFUSED: worker in production requires TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

runWorker().then(
  () => process.exit(0),
  (err) => {
    console.error('[worker] fatal:', err);
    process.exit(1);
  },
);

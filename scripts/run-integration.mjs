#!/usr/bin/env node
// Integration test runner: resets the test schema, applies migrations, then runs
// node --test with the tsx loader against DATABASE_URL (welcome_test by default).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations } from './migrate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const databaseUrl =
  process.env.INTEGRATION_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://localhost:5432/welcome_test';

if (process.env.APP_ENV === 'production') {
  console.error('REFUSED: integration tests cannot run when APP_ENV=production');
  process.exit(1);
}

// Deterministic state: fresh schema, then migrations (also proves clean apply).
const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await sql.unsafe('CREATE SCHEMA public');
  await sql.unsafe('GRANT ALL ON SCHEMA public TO current_user');
} finally {
  await sql.end({ timeout: 5 });
}
await runMigrations({ databaseUrl });

// Test env: fixed pepper/key, dev OTP exposure enabled for assertions.
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  APP_ENV: 'development',
  AUTH_DEV_EXPOSE_OTP: 'true',
  HASH_PEPPER: 'integration-test-pepper-0123456789abcdef',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  APP_BASE_URL: 'http://localhost:3000',
  TELEGRAM_WEBHOOK_SECRET: 'integration-telegram-webhook-secret',
  TELEGRAM_BOT_USERNAME: 'WELCOME_test_bot',
  // Enrichment: offline mock provider. A real Vertex call never happens in CI —
  // the live check is gated behind ENRICHMENT_LIVE=1 and run by hand.
  ENRICHMENT_PROVIDER: 'mock',
};

const result = spawnSync(
  process.execPath,
  // Sequential files: integration tests share one DB and the phase-3 worker
  // ticks must not steal each other's outbox jobs mid-assertion.
  ['--import', 'tsx', '--test', '--test-concurrency=1', 'tests/integration/*.test.ts'],
  { stdio: 'inherit', env, cwd: ROOT },
);
process.exit(result.status ?? 1);

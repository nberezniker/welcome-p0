#!/usr/bin/env node
// DEV ONLY: drops and recreates the public schema, then re-applies all migrations.
// Refuses to run when APP_ENV=production.
import postgres from 'postgres';
import { runMigrations, defaultDatabaseUrl } from './migrate.mjs';

if (process.env.APP_ENV === 'production') {
  console.error('REFUSED: db-reset cannot run when APP_ENV=production');
  process.exit(1);
}

const databaseUrl = defaultDatabaseUrl();
const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await sql.unsafe('CREATE SCHEMA public');
  await sql.unsafe('GRANT ALL ON SCHEMA public TO current_user');
  console.error('schema dropped and recreated');
} finally {
  await sql.end({ timeout: 5 });
}

const r = await runMigrations();
console.log(`db-reset done: ${r.applied.length} migration(s) applied`);

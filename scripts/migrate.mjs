#!/usr/bin/env node
// Applies db/migrations/*.sql in filename order. Records applied versions in
// schema_migrations. Safe to re-run: already-applied files are skipped.
// Usage: node scripts/migrate.mjs   (env: DATABASE_URL)
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

export function defaultDatabaseUrl() {
  return process.env.DATABASE_URL || 'postgres://localhost:5432/welcome_dev';
}

/** Returns the list of {version, name} migration files, sorted by filename. */
export async function listMigrationFiles(dir = MIGRATIONS_DIR) {
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const m = /^(\d+)_/.exec(f);
      if (!m) throw new Error(`Migration file ${f} must be named <version>_<description>.sql`);
      return { version: m[1], name: f };
    });
}

/**
 * Applies pending migrations. `log` lets callers silence output.
 * Returns { applied: string[] } — versions applied in this run.
 */
export async function runMigrations({ databaseUrl = defaultDatabaseUrl(), log = console.error } = {}) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const files = await listMigrationFiles();
    const appliedRows = await sql`SELECT version FROM schema_migrations`;
    const applied = new Set(appliedRows.map((r) => r.version));

    const appliedNow = [];
    for (const file of files) {
      if (applied.has(file.version)) continue;
      const content = await readFile(path.join(MIGRATIONS_DIR, file.name), 'utf8');
      // One transaction per migration: all-or-nothing, recorded atomically.
      await sql.begin(async (tx) => {
        await tx.unsafe(content);
        await tx`INSERT INTO schema_migrations (version, name) VALUES (${file.version}, ${file.name})`;
      });
      appliedNow.push(file.version);
      log(`applied ${file.version} ${file.name}`);
    }
    if (appliedNow.length === 0) log('no pending migrations');
    return { applied: appliedNow };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// CLI entry
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations()
    .then((r) => {
      process.exitCode = 0;
      if (r.applied.length === 0) console.log('migrations: up to date');
    })
    .catch((err) => {
      console.error('migration failed:', err.message);
      process.exitCode = 1;
    });
}

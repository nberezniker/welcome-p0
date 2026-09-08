// E2E global setup: deterministic welcome_e2e DB (fresh schema + migrations)
// + warmup of the pages the smoke test visits.
//
// The warmup matters: `next dev` compiles routes on demand, and navigating
// pages while other routes compile mid-test triggers dev-only races (RSC
// manifest JSON.parse errors). Pre-compiling every route here keeps the test
// deterministic. Runs after Playwright has started the webServer.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const databaseUrl = process.env.E2E_DATABASE_URL || 'postgres://localhost:5432/welcome_e2e';
const baseURL = `http://127.0.0.1:${process.env.E2E_PORT ?? 3111}`;

const WARMUP_PATHS = [
  '/', '/login', '/legal/privacy', '/legal/terms', '/me', '/me/profile', '/me/contacts', '/me/privacy', '/organizer',
  // API route handlers also compile on demand — prove each family compiles.
  '/api/locale', '/api/auth/otp/request', '/api/auth/otp/verify', '/api/auth/logout',
  '/api/me/profile', '/api/me/contacts', '/api/me/notes', '/api/me/export',
  '/api/me/memberships/00000000-0000-0000-0000-000000000000',
  '/api/events/00000000-0000-0000-0000-000000000000',
  '/api/events/00000000-0000-0000-0000-000000000000/join',
  '/api/introductions', '/api/blocks', '/api/reports', '/api/consents',
  '/api/organizer/events', '/api/organizer/campaigns',
  '/api/channels/telegram', '/api/registration-claims',
];

async function warmup() {
  const deadline = Date.now() + 120_000;
  for (const p of WARMUP_PATHS) {
    let ok = false;
    while (Date.now() < deadline && !ok) {
      try {
        const res = await fetch(`${baseURL}${p}`, { redirect: 'manual' });
        // Any response (200, 3xx to /login, even 500-free 4xx) proves the route compiled.
        ok = res.status < 500;
      } catch {
        ok = false;
      }
      if (!ok) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!ok) throw new Error(`warmup failed for ${p}`);
  }
}

export default async function globalSetup() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await sql.unsafe('CREATE SCHEMA public');
    await sql.unsafe('GRANT ALL ON SCHEMA public TO current_user');
  } finally {
    await sql.end({ timeout: 5 });
  }
  const result = spawnSync('node', ['scripts/migrate.mjs'], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (result.status !== 0) {
    throw new Error(`E2E migrations failed with exit code ${result.status}`);
  }
  await warmup();
}

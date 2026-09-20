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
  '/', '/login', '/legal/privacy', '/legal/terms', '/me', '/me/profile', '/me/contacts', '/me/privacy', '/me/security',
  '/me/connections',
  '/me/notes',
  '/organizer',
  // API route handlers also compile on demand — prove each family compiles.
  '/api/locale', '/api/auth/otp/request', '/api/auth/otp/verify', '/api/auth/logout', '/api/auth/demo-login-info',
  '/api/me/profile', '/api/me/contacts', '/api/me/contacts/import', '/api/me/notes', '/api/me/export', '/api/me/sessions',
  '/api/me/followup',
  '/api/providers',
  '/api/me/memberships/00000000-0000-0000-0000-000000000000',
  '/api/events/00000000-0000-0000-0000-000000000000',
  '/api/events/00000000-0000-0000-0000-000000000000/ics',
  '/api/events/00000000-0000-0000-0000-000000000000/recommendations',
  '/api/events/00000000-0000-0000-0000-000000000000/join',
  '/api/introductions', '/api/blocks', '/api/reports', '/api/consents',
  '/api/organizer/events', '/api/organizer/campaigns',
  '/api/organizer/events/00000000-0000-0000-0000-000000000000/analytics',
  '/api/organizer/events/00000000-0000-0000-0000-000000000000/badge-links',
  '/api/channels/telegram', '/api/registration-claims',
  // Param-bearing pages compile on demand too (signed out → /login redirect).
  '/organizer/events/00000000-0000-0000-0000-000000000000/badges',
  // Phase 2: the Google OAuth handshake routes. Signed out, `start` answers with
  // a redirect to /login and the callback abandons the flow uncompleted — both
  // prove the route compiled, which is the point of warming them.
  '/api/oauth/google/start?provider=google-contacts',
  '/api/oauth/google/start?provider=google-calendar',
  '/api/oauth/google/callback',
  // Preview images (og-image.spec.ts). A missing slug 404s, which still proves
  // the route compiled — and image generation is the slowest path in the suite.
  // The landing card is the slowest of the three to compile and the one the
  // chat-preview spec fetches first.
  '/opengraph-image',
  '/p/00000000-0000-0000-0000-000000000000/opengraph-image',
  '/e/00000000-0000-0000-0000-000000000000/opengraph-image',
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

/**
 * Route-manifest probe — the one check `warmup()` cannot make.
 *
 * The warmup deliberately accepts any status below 500, because several of its
 * paths carry bogus ids and a 404 there is the CORRECT answer (a missing slug
 * still proves its route compiled). That blindness has a cost: a `next dev`
 * whose route manifest is missing or stale — observed under CPU starvation on
 * a loaded machine, where every API route answered 404 for the whole run —
 * sails through the warmup and then fails dozens of tests with unrelated-looking
 * 404s, several minutes later, one assertion at a time.
 *
 * `GET /api/auth/otp/request` is the discriminator: the route exports POST only,
 * so a healthy server answers 405 (the handler exists, the method does not).
 * A 404 means NO handler — the manifest is broken, not the request. Fail here,
 * at startup, with a message that says what to do.
 */
const MANIFEST_PROBE_PATH = '/api/auth/otp/request';

async function assertRoutesServed() {
  const deadline = Date.now() + 30_000;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}${MANIFEST_PROBE_PATH}`);
      if (res.status !== 404 && res.status < 500) return; // 405 = the handler is there
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `the dev server answered ${MANIFEST_PROBE_PATH} with ${last} — it is not serving its API routes. ` +
      'A 404 on this path means the route manifest is missing or stale (a starved `next dev` can come up ' +
      'without its API routes), and an unreachable server reads the same way here. ' +
      'Re-run the suite; if it repeats, stop the stray `next dev` / clear .next and try again.',
  );
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
  await assertRoutesServed();
  await warmup();
}

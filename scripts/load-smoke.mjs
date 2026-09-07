#!/usr/bin/env node
// AC-53 load smoke — LOCAL-ONLY INDICATIVE numbers, clearly labeled as such.
// Measures, against a local production build (next build + next start):
//   1. mutation phase: 50 CONCURRENT POST /api/events/[eventId]/join
//      (50 distinct authenticated joiners, one wave);
//   2. read phase: 200 GET /api/events/[eventId]/recommendations (concurrency
//      50) against an event with 200 directory-opted-in members.
// Writes evidence/load-smoke.json and prints p95/error-rate summaries.
//
// Env: LOAD_SMOKE_DATABASE_URL (default welcome_test — schema is reset!),
//      LOAD_SMOKE_PORT (default 3177), LOAD_SMOKE_SKIP_BUILD=1 to reuse .next.
import { spawnSync, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { performance } from 'node:perf_hooks';
import { runMigrations } from './migrate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = path.join(ROOT, 'evidence');
const PORT = Number(process.env.LOAD_SMOKE_PORT ?? 3177);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const databaseUrl =
  process.env.LOAD_SMOKE_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://localhost:5432/welcome_test';

const HASH_PEPPER = process.env.HASH_PEPPER || 'load-smoke-pepper-0123456789abcdef';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || Buffer.alloc(32, 9).toString('base64');

const N_MEMBERS = 200; // event members for the recommendations read phase
const N_JOINERS = 50; // concurrent join mutations
const N_REQ_READ = 200; // recommendation GETs
const READ_CONCURRENCY = 50;

const hmac = (v) => createHmac('sha256', HASH_PEPPER).update(v, 'utf8').digest('hex');
const sha256 = (v) => createHash('sha256').update(v, 'utf8').digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

const runtimeEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  APP_ENV: 'development',
  HASH_PEPPER,
  ENCRYPTION_KEY,
  APP_BASE_URL: BASE_URL,
};

async function waitForHealth(child) {
  const deadline = Date.now() + 45_000;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`next server exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
      lastErr = new Error(`health returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become healthy: ${lastErr?.message ?? 'timeout'}`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 10) / 10;
}

// ---------------------------------------------------------------------------
console.log('LOAD SMOKE — LOCAL-ONLY INDICATIVE NUMBERS (not production capacity claims)');
console.log(`db=${databaseUrl} members=${N_MEMBERS} joiners=${N_JOINERS} readReqs=${N_REQ_READ}@${READ_CONCURRENCY}`);

const sql = postgres(databaseUrl, { max: 10 });
try {
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await sql.unsafe('CREATE SCHEMA public');
  await sql.unsafe('GRANT ALL ON SCHEMA public TO current_user');
} finally {
  await sql.end({ timeout: 5 });
}
await runMigrations({ databaseUrl });

const seedSql = postgres(databaseUrl, { max: 10 });
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
let eventId;

await seedSql.begin(async (tx) => {
  const org = await tx`INSERT INTO organizers (display_name) VALUES ('Load Smoke') RETURNING id`;
  const orgId = org[0].id;
  const ev = await tx`
    INSERT INTO events (organizer_id, slug, name, mode, access_mode, status)
    VALUES (${orgId}, 'load-smoke', 'Load Smoke Meetup', 'offline', 'public', 'active')
    RETURNING id
  `;
  eventId = ev[0].id;

  // reader + 200 directory members with matching overlap
  for (let i = 0; i < N_MEMBERS; i++) {
    const email = `member-${i}@load-smoke.test`;
    const acc = await tx`
      INSERT INTO accounts (auth_subject, email_lookup_hash) VALUES (${'email:' + hmac(email)}, ${hmac(email)})
      RETURNING id
    `;
    const prof = await tx`
      INSERT INTO profiles (account_id, public_slug, display_name, offer_tags, need_tags)
      VALUES (${acc[0].id}, ${randomBytes(16).toString('base64url')}, ${`Member ${i}`}, ${[`skill-${i % 10}`]}, ${[`skill-${(i + 1) % 10}`]})
      RETURNING id
    `;
    await tx`
      INSERT INTO event_memberships (event_id, profile_id, directory_visible, offer_tags, need_tags)
      VALUES (${eventId}, ${prof[0].id}, true, ${[`skill-${i % 10}`]}, ${[`skill-${(i + 1) % 10}`]})
    `;
  }

  // reader session = member[0]
  const readerToken = newToken();
  const reader = await tx`SELECT id FROM accounts WHERE auth_subject = ${'email:' + hmac('member-0@load-smoke.test')}`;
  await tx`
    INSERT INTO sessions (account_id, token_hash, expires_at)
    VALUES (${reader[0].id}, ${sha256(readerToken)}, now() + interval '1 day')
  `;

  // 51 joiners (1 warm-up + 50 measured), no membership yet, own sessions
  const joinerTokens = [];
  for (let i = 0; i < N_JOINERS + 1; i++) {
    const email = `joiner-${i}@load-smoke.test`;
    const acc = await tx`
      INSERT INTO accounts (auth_subject, email_lookup_hash) VALUES (${'email:' + hmac(email)}, ${hmac(email)})
      RETURNING id
    `;
    await tx`
      INSERT INTO profiles (account_id, public_slug, display_name)
      VALUES (${acc[0].id}, ${randomBytes(16).toString('base64url')}, ${`Joiner ${i}`})
    `;
    const token = newToken();
    await tx`
      INSERT INTO sessions (account_id, token_hash, expires_at)
      VALUES (${acc[0].id}, ${sha256(token)}, now() + interval '1 day')
    `;
    joinerTokens.push(token);
  }
  seedSql.readerToken = readerToken;
  seedSql.joinerTokens = joinerTokens;
});
const readerToken = seedSql.readerToken;
const joinerTokens = seedSql.joinerTokens;
await seedSql.end({ timeout: 5 });
console.log(`seeded: event ${eventId}, ${N_MEMBERS} members, ${N_JOINERS + 1} joiner sessions`);

// ---------------------------------------------------------------------------
if (process.env.LOAD_SMOKE_SKIP_BUILD !== '1') {
  console.log('building (next build)…');
  const build = spawnSync('node', [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
    cwd: ROOT, env: runtimeEnv, stdio: ['ignore', 'inherit', 'inherit'], timeout: 600_000,
  });
  if (build.status !== 0) throw new Error('next build failed — load smoke aborted');
}

console.log(`starting next start on :${PORT}…`);
const server = spawn('node', [path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(PORT)], {
  cwd: ROOT, env: runtimeEnv, stdio: ['ignore', 'ignore', 'inherit'],
});
let serverLogs = '';
server.stderr?.on('data', (d) => (serverLogs += String(d)));
let serverClosed = false;
server.on('exit', () => (serverClosed = true));

try {
  await waitForHealth(server);
  console.log('server healthy');

  // warm-up: compile the join + recommendations routes with throwaway calls
  const warmJoin = await fetch(`${BASE_URL}/api/events/${eventId}/join`, {
    method: 'POST', headers: { cookie: `welcome_session=${joinerTokens[0]}`, 'content-type': 'application/json' }, body: '{}',
  });
  if (!warmJoin.ok) throw new Error(`warm-up join returned ${warmJoin.status}`);
  const warmCookie = `welcome_session=${readerToken}`;
  for (let i = 0; i < 3; i++) {
    await fetch(`${BASE_URL}/api/events/${eventId}/recommendations`, { headers: { cookie: warmCookie } });
  }

  // ---- mutation phase: 50 concurrent joins -------------------------------
  const joinLatencies = [];
  const joinStatuses = [];
  const joinStart = performance.now();
  await Promise.all(
    joinerTokens.slice(1).map(async (token) => {
      const t0 = performance.now();
      const res = await fetch(`${BASE_URL}/api/events/${eventId}/join`, {
        method: 'POST', headers: { cookie: `welcome_session=${token}`, 'content-type': 'application/json' }, body: '{}',
      });
      joinLatencies.push(performance.now() - t0);
      joinStatuses.push(res.status);
    }),
  );
  const joinWallMs = performance.now() - joinStart;
  joinLatencies.sort((a, b) => a - b);

  // ---- read phase: 200 recommendation GETs at concurrency 50 --------------
  const readLatencies = [];
  const readStatuses = [];
  let next = 0;
  const worker = async () => {
    while (next < N_REQ_READ) {
      const i = next++;
      const t0 = performance.now();
      const res = await fetch(`${BASE_URL}/api/events/${eventId}/recommendations`, { headers: { cookie: warmCookie } });
      readLatencies.push(performance.now() - t0);
      readStatuses.push(res.status);
    }
  };
  const readStart = performance.now();
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
  const readWallMs = performance.now() - readStart;
  readLatencies.sort((a, b) => a - b);

  const joinErrors = joinStatuses.filter((s) => s < 200 || s >= 300).length;
  const readErrors = readStatuses.filter((s) => s < 200 || s >= 300).length;

  const summary = {
    note: 'LOCAL-ONLY INDICATIVE NUMBERS — not production capacity claims',
    generated_at: new Date().toISOString(),
    commit,
    environment: { mode: 'next build + next start (production mode)', db: databaseUrl },
    scenario: { event_id: eventId, members: N_MEMBERS, joiners: N_JOINERS },
    mutation_join: {
      endpoint: `/api/events/${eventId}/join`, method: 'POST', concurrent: N_JOINERS, wall_ms: Math.round(joinWallMs),
      p50_ms: percentile(joinLatencies, 50), p95_ms: percentile(joinLatencies, 95), max_ms: percentile(joinLatencies, 100),
      error_rate: joinErrors / N_JOINERS, statuses: joinStatuses.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {}),
    },
    read_recommendations: {
      endpoint: `/api/events/${eventId}/recommendations`, method: 'GET', requests: N_REQ_READ,
      concurrency: READ_CONCURRENCY, wall_ms: Math.round(readWallMs),
      p50_ms: percentile(readLatencies, 50), p95_ms: percentile(readLatencies, 95), max_ms: percentile(readLatencies, 100),
      error_rate: readErrors / N_REQ_READ, statuses: readStatuses.reduce((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {}),
    },
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, 'load-smoke.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('======== LOAD SMOKE (LOCAL-ONLY INDICATIVE) ========');
  console.log(`join POST ×${N_JOINERS} concurrent: p50=${summary.mutation_join.p50_ms}ms p95=${summary.mutation_join.p95_ms}ms max=${summary.mutation_join.max_ms}ms error_rate=${summary.mutation_join.error_rate}`);
  console.log(`recommendations GET ×${N_REQ_READ} (${READ_CONCURRENCY} conc): p50=${summary.read_recommendations.p50_ms}ms p95=${summary.read_recommendations.p95_ms}ms max=${summary.read_recommendations.max_ms}ms error_rate=${summary.read_recommendations.error_rate}`);
  console.log('results written to evidence/load-smoke.json');

  if (summary.mutation_join.error_rate > 0.05 || summary.read_recommendations.error_rate > 0.05) {
    console.error('LOAD SMOKE: error rate above 5% — inspect before release');
    process.exitCode = 1;
  }
} finally {
  if (!serverClosed) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
  }
  if (serverLogs) console.log('--- server log tail ---\n' + serverLogs.slice(-2000));
}

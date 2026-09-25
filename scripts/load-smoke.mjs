#!/usr/bin/env node
// AC-53 load smoke — LOCAL-ONLY INDICATIVE numbers, clearly labeled as such.
// Measures, against a local production build (next build + next start):
//   1. mutation phase: 50 CONCURRENT POST /api/events/[eventId]/join
//      (50 distinct authenticated joiners, one wave);
//   2. read phase: 200 GET /api/events/[eventId]/recommendations (concurrency
//      50) against an event with 200 directory-opted-in members.
// Writes evidence/load-smoke.json and prints p95/error-rate summaries.
//
// Judgement: the smoke FAILS only on real errors (see "Response judgement"
// below) — deliberate 429 + Retry-After throttling of the mutation burst is the
// rate limiter working, and is reported, not counted against the run.
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

import { PRODUCTION_ACK_FLAG, looksProductionLike } from '../src/domain/production-guard.ts';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = path.join(ROOT, 'evidence');
const PORT = Number(process.env.LOAD_SMOKE_PORT ?? 3177);
const BASE_URL = `http://127.0.0.1:${PORT}`;
// The run RESETS the target schema (`DROP SCHEMA public CASCADE` at the line
// marked below) — so the target must be a throwaway database, never a real one.
// On 2026-09-25 an inherited production DATABASE_URL made this run wipe the
// live database (it only ever regenerates demo data, but the real registrations,
// the Google grant and the audit history were gone). Since then the target is
// opt-in: a dedicated variable first, and a production-looking URL is refused
// without an explicit acknowledgement.
const databaseUrl =
  process.env.LOAD_SMOKE_DATABASE_URL ||
  (() => {
    const fallback = 'postgres://localhost:5432/welcome_test';
    if (looksProductionLike({ databaseUrl: process.env.DATABASE_URL })) {
      if (process.argv.includes(PRODUCTION_ACK_FLAG)) {
        console.error('load:smoke — acknowledged: running against the production-looking DATABASE_URL');
        return process.env.DATABASE_URL;
      }
      console.error(
        'load:smoke — REFUSED: the inherited DATABASE_URL looks like a production ' +
        'database and this run would DROP ITS SCHEMA. ' +
        `Set LOAD_SMOKE_DATABASE_URL to a throwaway database${PRODUCTION_ACK_FLAG.slice(0, 0)}` +
        `, or pass ${PRODUCTION_ACK_FLAG} to override.`
      );
      process.exit(2);
    }
    return fallback;
  })();

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
// Response judgement — WHY a 429 is NOT an error here. Do not "fix" this back.
//
// The annotation asks for exactly this shape ("50 concurrent writes"), and the
// join endpoint is deliberately rate-limited: a per-IP control (10 joins/min,
// `event_join` in src/lib/http.ts IP_RATE_RULES) on top of the DB-level
// per-subject limit. The CORRECT behaviour of a rate-limited endpoint under a
// burst from one client is to refuse the excess with 429 + Retry-After — that
// is the control doing its job, not a failure. Counting those refusals as
// errors makes a healthy run look red and, worse, invites somebody to weaken
// the limiter until the number turns green, which is the opposite of the goal.
//
// Only these are REAL errors, and only they can fail the smoke:
//   * 5xx — the server actually broke;
//   * any other non-2xx — including a 429 WITHOUT Retry-After, which breaks the
//     client contract and is therefore a bug rather than throttling.
// A scenario that produced ZERO successful requests also fails: "every request
// was refused" is not a healthy rate limit, it is an unusable endpoint.
//
// Expected throttling stays fully visible (count, rate, status histogram): if
// the size of the surviving slice of the burst changes, that must be readable.
// ---------------------------------------------------------------------------
const REAL_ERROR_CATEGORIES = ['server_error', 'unexpected_status', 'throttled_without_retry_after'];

function classifyResponse(status, retryAfter) {
  if (status >= 500) return 'server_error';
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429) return retryAfter ? 'throttled' : 'throttled_without_retry_after';
  return 'unexpected_status';
}

/** Per-phase accumulator: latency, status histogram and category counts in one pass. */
function newPhase() {
  return { latencies: [], statuses: {}, categories: {} };
}

function observe(phase, res, ms) {
  phase.latencies.push(ms);
  phase.statuses[res.status] = (phase.statuses[res.status] ?? 0) + 1;
  const category = classifyResponse(res.status, res.headers.get('retry-after'));
  phase.categories[category] = (phase.categories[category] ?? 0) + 1;
}

/** `expected` = how many requests the phase issued; every rate is over that. */
function summarizePhase(phase, expected) {
  phase.latencies.sort((a, b) => a - b);
  const count = (category) => phase.categories[category] ?? 0;
  const realErrors = REAL_ERROR_CATEGORIES.reduce((n, c) => n + count(c), 0);
  return {
    p50_ms: percentile(phase.latencies, 50),
    p95_ms: percentile(phase.latencies, 95),
    max_ms: percentile(phase.latencies, 100),
    // error_rate counts REAL errors only — the deliberate 429s are reported
    // separately below and never enter this number (see the note above).
    error_rate: realErrors / expected,
    success_rate: count('ok') / expected,
    successes: count('ok'),
    expected_throttled: count('throttled'),
    expected_throttle_rate: count('throttled') / expected,
    throttle_without_retry_after: count('throttled_without_retry_after'),
    real_errors: realErrors,
    real_error_categories: Object.fromEntries(
      REAL_ERROR_CATEGORIES.filter((c) => count(c) > 0).map((c) => [c, count(c)]),
    ),
    statuses: phase.statuses,
    categories: phase.categories,
  };
}

/** Collects why a phase failed; empty = healthy. */
function judgePhase(label, summary, failures) {
  if (summary.real_errors > 0) {
    failures.push(
      `${label}: ${summary.real_errors} real error(s) ${JSON.stringify(summary.real_error_categories)}`,
    );
  } else if (summary.successes === 0) {
    failures.push(
      `${label}: no successful request at all (${summary.requests} issued, ` +
        `throttled=${summary.expected_throttled}) — an endpoint that refuses everything is not healthy`,
    );
  }
}

/** One line per phase for the log, so the categories are never hidden by a rate. */
function describePhase(label, summary) {
  const histogram = Object.entries(summary.statuses)
    .map(([status, n]) => `${status}×${n}`)
    .join(', ');
  return (
    `${label}: ${summary.successes} ok · ${summary.expected_throttled} throttled (429+Retry-After) · ` +
    `${summary.real_errors} real error(s) — statuses: ${histogram}\n` +
    `    p50=${summary.p50_ms}ms p95=${summary.p95_ms}ms max=${summary.max_ms}ms · ` +
    `error_rate=${summary.error_rate} (real errors only)`
  );
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
  const joinPhase = newPhase();
  const joinStart = performance.now();
  await Promise.all(
    joinerTokens.slice(1).map(async (token) => {
      const t0 = performance.now();
      const res = await fetch(`${BASE_URL}/api/events/${eventId}/join`, {
        method: 'POST', headers: { cookie: `welcome_session=${token}`, 'content-type': 'application/json' }, body: '{}',
      });
      observe(joinPhase, res, performance.now() - t0);
    }),
  );
  const joinWallMs = performance.now() - joinStart;

  // ---- read phase: 200 recommendation GETs at concurrency 50 --------------
  const readPhase = newPhase();
  let next = 0;
  const worker = async () => {
    while (next < N_REQ_READ) {
      next++;
      const t0 = performance.now();
      const res = await fetch(`${BASE_URL}/api/events/${eventId}/recommendations`, { headers: { cookie: warmCookie } });
      observe(readPhase, res, performance.now() - t0);
    }
  };
  const readStart = performance.now();
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
  const readWallMs = performance.now() - readStart;

  const joinSummary = { requests: N_JOINERS, ...summarizePhase(joinPhase, N_JOINERS) };
  const readSummary = { requests: N_REQ_READ, ...summarizePhase(readPhase, N_REQ_READ) };

  const failures = [];
  judgePhase(`join POST ×${N_JOINERS}`, joinSummary, failures);
  judgePhase(`recommendations GET ×${N_REQ_READ}`, readSummary, failures);
  const verdict = failures.length === 0 ? 'PASS' : 'FAIL';

  const summary = {
    note: 'LOCAL-ONLY INDICATIVE NUMBERS — not production capacity claims',
    judgement:
      'error_rate counts REAL errors only (5xx, unexpected non-2xx, 429 without Retry-After). ' +
      'A 429 WITH Retry-After is expected throttling of a deliberate burst — the rate limiter working — ' +
      'and is reported as expected_throttled/expected_throttle_rate instead. ' +
      'A scenario with zero successful requests also fails.',
    verdict,
    verdict_detail:
      failures.length > 0
        ? failures.join('; ')
        : `no real errors in either scenario; ${joinSummary.expected_throttled} join request(s) were throttled ` +
          `by the deliberate per-IP limit (429 + Retry-After), which is the control working as designed`,
    generated_at: new Date().toISOString(),
    commit,
    environment: { mode: 'next build + next start (production mode)', db: databaseUrl },
    scenario: { event_id: eventId, members: N_MEMBERS, joiners: N_JOINERS },
    mutation_join: {
      endpoint: `/api/events/${eventId}/join`, method: 'POST', concurrent: N_JOINERS, wall_ms: Math.round(joinWallMs),
      ...joinSummary,
    },
    read_recommendations: {
      endpoint: `/api/events/${eventId}/recommendations`, method: 'GET', requests: N_REQ_READ,
      concurrency: READ_CONCURRENCY, wall_ms: Math.round(readWallMs),
      ...readSummary,
    },
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, 'load-smoke.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('======== LOAD SMOKE (LOCAL-ONLY INDICATIVE) ========');
  console.log(describePhase(`join POST ×${N_JOINERS} concurrent`, summary.mutation_join));
  console.log(describePhase(`recommendations GET ×${N_REQ_READ} (${READ_CONCURRENCY} conc)`, summary.read_recommendations));
  console.log(`VERDICT: ${verdict} — ${summary.verdict_detail}`);
  console.log('results written to evidence/load-smoke.json');

  if (verdict === 'FAIL') process.exitCode = 1;
} finally {
  if (!serverClosed) {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
  }
  if (serverLogs) console.log('--- server log tail ---\n' + serverLogs.slice(-2000));
}

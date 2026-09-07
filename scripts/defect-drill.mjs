#!/usr/bin/env node
// Controlled defect drill (Phase 5, item 9): proves the security gates can
// actually FAIL. Three steps:
//   1. Inject a marked defect into src/lib/public-profile.ts (regex replace on
//      disk) that leaks PRIVATE contact values into the public projection →
//      run the existing public-projection integration test → expect FAIL,
//      output → evidence/defect-drill-fail.log
//   2. Revert the patch from git → re-run → expect PASS,
//      output → evidence/defect-drill-pass.log
//   3. Summarize → evidence/DEFECT_DRILL.md
// Guards: refuses to run on a dirty worktree; exits non-zero if any step
// misbehaves (defect did not fail the test / revert did not pass / residue).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations } from './migrate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = 'src/lib/public-profile.ts';
const TARGET_PATH = path.join(ROOT, TARGET);
const TEST_FILE = 'tests/integration/profile.test.ts';
const TEST_NAME_PATTERN = 'public API returns ONLY the public projection';
const EVIDENCE_DIR = path.join(ROOT, 'evidence');

function fail(message) {
  console.error(`DRILL-FAIL: ${message}`);
  process.exit(1);
}

function git(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { code: res.status, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() };
}

// --- Guard: refuse to run on a dirty worktree -------------------------------
const status = git(['status', '--porcelain']);
if (status.code !== 0) fail(`git status failed: ${status.err}`);
if (status.out !== '') {
  fail(`worktree is not clean — the drill needs a guaranteed-revertible tree:\n${status.out}`);
}

const commitAtStart = git(['rev-parse', 'HEAD']).out;
console.log(`defect drill on commit ${commitAtStart}`);

// --- Deterministic test DB (same procedure as run-integration.mjs) ----------
const databaseUrl =
  process.env.INTEGRATION_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgres://localhost:5432/welcome_test';
if (process.env.APP_ENV === 'production') fail('refused: drill cannot run with APP_ENV=production');
const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await sql.unsafe('CREATE SCHEMA public');
  await sql.unsafe('GRANT ALL ON SCHEMA public TO current_user');
} finally {
  await sql.end({ timeout: 5 });
}
await runMigrations({ databaseUrl });

const testEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  APP_ENV: 'development',
  AUTH_DEV_EXPOSE_OTP: 'true',
  HASH_PEPPER: 'integration-test-pepper-0123456789abcdef',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  APP_BASE_URL: 'http://localhost:3000',
  TELEGRAM_WEBHOOK_SECRET: 'integration-telegram-webhook-secret',
  TELEGRAM_BOT_USERNAME: 'WELCOME_test_bot',
};

function runTargetTest(label) {
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', `--test-name-pattern=${TEST_NAME_PATTERN}`, TEST_FILE],
    { cwd: ROOT, env: testEnv, encoding: 'utf8' },
  );
  const output = `# defect drill — ${label}\n# commit: ${commitAtStart}\n# exit code: ${res.status}\n\n${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { code: res.status, output };
}

// --- Step 1: inject the defect, expect the gate to FAIL ---------------------
const original = readFileSync(TARGET_PATH, 'utf8');
if (!original.includes('public_enabled = true')) {
  fail(`injection point not found in ${TARGET} — the file changed, refusing to blind-patch`);
}
const INJECTION_MARK = '/* DEFECT-DRILL-INJECTION (temporary, reverted by the drill): private contact values leak into the public projection */';
const injected = original.replace(
  'public_enabled = true',
  `public_enabled IN (true, false) ${INJECTION_MARK}`,
);
if (injected === original) fail('regex replace produced no change');
writeFileSync(TARGET_PATH, injected, 'utf8');
console.log('step 1: defect injected into', TARGET);

const failRun = runTargetTest('FAIL expected (defect injected)');
mkdirSync(EVIDENCE_DIR, { recursive: true });
writeFileSync(path.join(EVIDENCE_DIR, 'defect-drill-fail.log'), failRun.output, 'utf8');
console.log(`step 1: gate run exit code = ${failRun.code} (expected non-zero)`);
if (failRun.code === 0) {
  // Revert before bailing so the tree never stays dirty.
  git(['checkout', '--', TARGET]);
  fail('the defect did NOT fail the public-projection test — the gate is not actually protective');
}

// --- Step 2: revert, expect the gate to PASS --------------------------------
git(['checkout', '--', TARGET]);
const afterRevert = readFileSync(TARGET_PATH, 'utf8');
if (afterRevert !== original) fail('revert did not restore the original file');
console.log('step 2: defect reverted from git');

const passRun = runTargetTest('PASS expected (defect reverted)');
writeFileSync(path.join(EVIDENCE_DIR, 'defect-drill-pass.log'), passRun.output, 'utf8');
console.log(`step 2: gate run exit code = ${passRun.code} (expected 0)`);
if (passRun.code !== 0) fail('the gate does not pass on the clean tree');

// --- Step 3: residue check + summary ----------------------------------------
const dirtyTracked = git(['status', '--porcelain', '--untracked-files=no']);
if (dirtyTracked.out !== '') fail(`tracked-file residue after the drill:\n${dirtyTracked.out}`);
if (git(['diff', '--stat']).out !== '') fail('git diff --stat is non-empty after the drill');
console.log('step 3: tree identical to the pre-drill state (no tracked residue)');

const summary = `# Defect drill — controlled defect injection (Phase 5, item 9)

- Date: ${new Date().toISOString()}
- Commit: ${commitAtStart}
- Injected defect: \`${TARGET}\` — \`loadPublicProfile\` contact query changed from
  \`public_enabled = true\` to \`public_enabled IN (true, false)\` (regex replace on disk,
  marked \`DEFECT-DRILL-INJECTION\`), so PRIVATE contact values leak into the public
  projection.
- Guard test: \`${TEST_NAME_PATTERN}\`
  (\`${TEST_FILE}\`, run via \`--test-name-pattern\`)
- Exit codes: with defect = ${failRun.code} (FAIL, expected); after revert = ${passRun.code} (PASS, expected)
- Logs: \`evidence/defect-drill-fail.log\`, \`evidence/defect-drill-pass.log\`
- Residue check: \`git status --porcelain --untracked-files=no\` empty and
  \`git diff --stat\` empty after the drill — the tree is identical to the pre-drill state.
- Conclusion: the public-projection gate FAILS on the injected leak and PASSES on the
  clean tree — the gate is protective.
`;
writeFileSync(path.join(EVIDENCE_DIR, 'DEFECT_DRILL.md'), summary, 'utf8');
console.log('step 3: summary written to evidence/DEFECT_DRILL.md');
console.log('DRILL-OK');

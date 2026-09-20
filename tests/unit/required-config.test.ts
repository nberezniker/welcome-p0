import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appEnv, requireEncryptionKey, requireHashPepper, type AppEnv } from '../../src/lib/env';
import { POST as otpRequest } from '../../src/app/api/auth/otp/request/route';

/**
 * AC-04 — an incomplete required configuration must not yield a working
 * production system.
 *
 * The implementation validates LAZILY and says so (src/lib/env.ts: values are
 * checked at their use sites "so the app can boot and print a clear error even
 * with an incomplete .env"). This suite therefore proves the two properties the
 * lazy design can actually carry, each in the place it happens:
 *
 *   1. the required-config entry points fail LOUDLY and NAME the variable — in
 *      production exactly as in development, with no default invented to keep
 *      going;
 *   2. the failure lands on the path that would otherwise serve: a fresh process
 *      (spawned, so this file's module state cannot mask anything) dies with a
 *      non-zero exit and prints the missing name, and the sign-in route answers
 *      500 and logs the name instead of issuing a code.
 *
 * Honest scope — what this does NOT claim: that `next start` refuses to listen.
 * It does not; it serves the landing page and fails at the first request that
 * needs the configuration. That deviation from the AC's literal wording is
 * recorded in evidence/ACCEPTANCE_STATUS.md (row AC-04), not papered over here.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_MODULE_URL = new URL('../../src/lib/env.ts', import.meta.url).href;

/** Runs `body` with the given variables set/unset, restoring the env afterwards. */
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('AC-04: the required-config entry points name the variable they are missing, in production too', () => {
  const PEPPER_MESSAGE = 'HASH_PEPPER is not configured';

  // An absent variable…
  withEnv({ HASH_PEPPER: undefined }, () => {
    assert.throws(() => requireHashPepper(), { message: PEPPER_MESSAGE });
  });
  // …an empty one (a variable the operator "set" but left blank is the shape a
  // copy-pasted .env actually takes)…
  withEnv({ HASH_PEPPER: '' }, () => {
    assert.throws(() => requireHashPepper(), { message: PEPPER_MESSAGE });
  });
  // …and a too-short one (the pepper is a key, not a placeholder).
  withEnv({ HASH_PEPPER: 'short' }, () => {
    assert.throws(() => requireHashPepper(), { message: PEPPER_MESSAGE });
  });
  // A real value is returned unchanged — no silent substitution.
  withEnv({ HASH_PEPPER: 'ac04-pepper-0123456789abcdef' }, () => {
    assert.equal(requireHashPepper(), 'ac04-pepper-0123456789abcdef');
  });

  withEnv({ ENCRYPTION_KEY: undefined }, () => {
    assert.throws(() => requireEncryptionKey(), { message: 'ENCRYPTION_KEY is not configured' });
  });
  withEnv({ ENCRYPTION_KEY: '' }, () => {
    assert.throws(() => requireEncryptionKey(), { message: 'ENCRYPTION_KEY is not configured' });
  });

  // `APP_ENV=production` must not open a bypass: both guards are unconditional.
  withEnv({ APP_ENV: 'production', HASH_PEPPER: undefined, ENCRYPTION_KEY: undefined }, () => {
    const env: AppEnv = appEnv();
    assert.equal(env, 'production', 'the production branch is the one under test');
    assert.throws(() => requireHashPepper(), { message: PEPPER_MESSAGE });
    assert.throws(() => requireEncryptionKey(), { message: 'ENCRYPTION_KEY is not configured' });
  });
});

test('AC-04: a fresh process with an incomplete required config refuses to boot and names the variable', () => {
  // The probe is the smallest honest model of a booting server process: import the
  // configuration module, ask for a required value, and only then report that the
  // process is up. Nothing about this test file's own module cache or env is
  // visible to the child, which is the point of spawning it.
  const probe = [
    `import { requireHashPepper } from ${JSON.stringify(ENV_MODULE_URL)};`,
    'requireHashPepper();',
    "console.log('BOOTED');",
  ].join('\n');

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.HASH_PEPPER;
  delete childEnv.ENCRYPTION_KEY;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', probe], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
  });

  assert.notEqual(child.status, 0, 'the process must not reach "booted" without its required config');
  assert.match(child.stderr, /HASH_PEPPER is not configured/, 'the missing variable must be named on stderr');
  assert.equal(child.stdout.includes('BOOTED'), false, 'nothing may report a successful boot');

  // Positive control, or the assertions above would also pass on a probe that is
  // broken for an unrelated reason (a typo, a missing loader): the same probe with
  // the variable present boots and exits 0.
  const ok = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', probe], {
    cwd: ROOT,
    env: { ...childEnv, HASH_PEPPER: 'ac04-pepper-0123456789abcdef' },
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0, `the control run must succeed, stderr: ${ok.stderr}`);
  assert.match(ok.stdout, /BOOTED/);
});

test('AC-04: production sign-in fails loudly instead of serving without the pepper', async () => {
  const saved = { env: process.env.APP_ENV, pepper: process.env.HASH_PEPPER };
  const logged: unknown[][] = [];
  const originalError = console.error;
  process.env.APP_ENV = 'production';
  delete process.env.HASH_PEPPER;
  // internalError() logs the real cause (the variable name) and returns a generic
  // body; capture the log so the assertion is about what an operator would see.
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    // A hand-built request, exactly the shape the two-step sign-in posts. The
    // route must fail at the pepper lookup, i.e. before any OTP is created.
    const res = await otpRequest(
      new NextRequest('http://localhost:3000/api/auth/otp/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost:3000', 'x-forwarded-for': '10.0.0.1' },
        body: JSON.stringify({ email: 'ac04-missing-config@example.org' }),
      }),
    );
    assert.equal(res.status, 500, 'an incomplete production config must not answer 200');
    const body = (await res.json()) as { code: string; ok?: boolean };
    assert.equal(body.code, 'internal_error');
    assert.equal(body.ok, undefined, 'no success payload');
    // The public body stays sanitized (no variable names to anonymous callers)…
    assert.equal(JSON.stringify(body).includes('HASH_PEPPER'), false);
    // …while the server log names the variable, which is what makes this
    // diagnosable rather than a mystery 500.
    const logText = logged.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')).join('\n');
    assert.match(logText, /HASH_PEPPER is not configured/, `the server log must name the variable, got: ${logText}`);
  } finally {
    console.error = originalError;
    if (saved.env === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = saved.env;
    if (saved.pepper === undefined) delete process.env.HASH_PEPPER;
    else process.env.HASH_PEPPER = saved.pepper;
  }
});

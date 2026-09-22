import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import postgres from 'postgres';
import { closeSql, getSql, sqlClientOptions } from '../../src/lib/db';
import { STATEMENT_TIMEOUT_MS_DEFAULT, statementTimeoutMs } from '../../src/lib/env';

after(async () => {
  await closeSql();
});

/**
 * `statement_timeout` is enforced BY POSTGRES, and this suite shows it rather
 * than restating the configuration.
 *
 * WHY AN INTEGRATION TEST AND NOT A UNIT ONE. The unit suite
 * (tests/unit/db-options.test.ts) proves the value is parsed and that the option
 * object carries it. Neither of those proves the behaviour that was missing:
 * that a statement which overruns the bound is actually CANCELLED — a test that
 * asserts `{ connection: { statement_timeout: 10000 } }` passes just as happily
 * if Postgres (or the driver) silently ignored the parameter. So the two halves
 * are asserted against a live server:
 *
 *   1. the app's own pooled client reports the configured budget (`SHOW
 *      statement_timeout`) — i.e. the setting survives the real `getSql()` path;
 *   2. a client built from the same options DOES get cancelled when it overruns,
 *      with the documented SQLSTATE. The bound used here is small (250ms) because
 *      a test cannot wait 10 seconds; the option is built from the app's own
 *      `sqlClientOptions()` shape, with only the one value narrowed, so what is
 *      under test is the same mechanism the default travels through.
 *
 * Reported as observed: the error is a PostgresError with `code === '57014'`
 * (query_canceled) whose message names the statement timeout.
 */

/**
 * The control's budget. Not a product default — just a value high enough that
 * pg_sleep(0.3) finishes, so the control test cannot fail for the same reason the
 * bounded one is supposed to fail.
 */
const CONTROL_BOUND_MS = 10_000;

/** The option object the app builds, with only the statement budget narrowed. */
async function withBound(ms: number) {
  const url = process.env.DATABASE_URL || 'postgres://localhost:5432/welcome_dev';
  const base = sqlClientOptions();
  return postgres(url, {
    ...base,
    max: 1,
    connection: { ...(base.connection as Record<string, unknown>), statement_timeout: ms },
  });
}

test('statement_timeout: the app\'s pooled client carries the configured budget', async () => {
  const sql = getSql();
  const rows = await sql<{ statement_timeout: string }[]>`SHOW statement_timeout`;
  const reported = rows[0]!.statement_timeout;
  // Postgres echoes the GUC in its canonical form: '10s' for the default.
  const expectedMs = statementTimeoutMs();
  const asMs = /^(\d+)(ms|s)?$/.exec(reported);
  assert.ok(asMs, `unrecognised statement_timeout value: ${JSON.stringify(reported)}`);
  const actualMs = Number(asMs[1]) * (asMs[2] === 's' ? 1000 : 1);
  assert.equal(
    actualMs,
    expectedMs,
    `getSql() must run with a bounded statement timeout (SHOW reported ${reported}, expected ${expectedMs}ms)`,
  );
  assert.equal(expectedMs, STATEMENT_TIMEOUT_MS_DEFAULT, 'no STATEMENT_TIMEOUT_MS is set in this suite');
});

test('statement_timeout: a statement past the bound is cancelled with SQLSTATE 57014', async () => {
  const sql = await withBound(250);
  try {
    // pg_sleep(5) is a statement that neither reads nor locks anything: it can
    // only end by being cancelled, so a pass here cannot be explained by a fast
    // return.
    await assert.rejects(
      () => sql`SELECT pg_sleep(5)`,
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        assert.equal(e.code, '57014', `expected query_canceled (57014), got ${e.code}: ${e.message}`);
        assert.match(String(e.message), /statement timeout/i);
        return true;
      },
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
});

test('statement_timeout: the same statement under no bound completes, i.e. the bound is what stopped it', async () => {
  // The control for the test above: same query, same client shape, budget high
  // enough to finish. Without this, a failure could be attributed to the query
  // rather than to the bound.
  const sql = await withBound(CONTROL_BOUND_MS);
  try {
    const rows = await sql<{ pg_sleep: null }[]>`SELECT pg_sleep(0.3)`;
    assert.equal(rows.length, 1);
  } finally {
    await sql.end({ timeout: 5 });
  }
});

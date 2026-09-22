import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATEMENT_TIMEOUT_MS_DEFAULT,
  STATEMENT_TIMEOUT_MS_MAX,
  STATEMENT_TIMEOUT_MS_MIN,
  statementTimeoutMs,
} from '../../src/lib/env';
import { sqlClientOptions } from '../../src/lib/db';

/**
 * The shared pool is BOUNDED, and the bound is not switchable off.
 *
 * WHAT THIS SUITE COVERS, and what it deliberately leaves to the integration
 * suite. `getSql()` sets `connect_timeout`, which bounds *reaching* the server;
 * it set nothing that bounds *running* on it, so a statement blocked on a lock
 * held a pooled connection until the client was torn down — i.e. indefinitely.
 * The fix is a `statement_timeout` sent as a connection parameter, which is
 * enforced by PostgreSQL rather than by the client (see the note on
 * `sqlClientOptions`). Two things therefore need proving, and they are provable
 * in different places:
 *
 *   1. the CONFIGURATION cannot silently become "no limit" — here, in pure code,
 *      because the interesting cases are all refusals (0 disables the GUC in
 *      PostgreSQL, so it is rejected, not honoured);
 *   2. the option actually reaches the pool with the configured value — here
 *      too, by asserting on the object `getSql()` builds. That is why
 *      `sqlClientOptions()` is exported: without it this wiring is only
 *      observable by opening a socket, which would make the cheapest half of the
 *      contract the most expensive one to check.
 *
 * The THIRD thing — that PostgreSQL really cancels a statement past the bound,
 * with SQLSTATE 57014 — is not a unit test. It needs a server, so it lives in
 * tests/integration/db-statement-timeout.test.ts, which also asserts that the
 * app's own pooled client reports the configured value via SHOW.
 */
test('statement timeout: the default is a bound, not a preference', () => {
  assert.equal(statementTimeoutMs(undefined), STATEMENT_TIMEOUT_MS_DEFAULT);
  assert.equal(STATEMENT_TIMEOUT_MS_DEFAULT, 10_000, 'the documented default is 10s');
});

test('statement timeout: 0 is refused, because PostgreSQL reads it as "no limit"', () => {
  // This is the one value that would undo the fix while looking deliberate.
  assert.equal(statementTimeoutMs('0'), STATEMENT_TIMEOUT_MS_DEFAULT);
  assert.equal(statementTimeoutMs('0'), 10_000);
  assert.equal(statementTimeoutMs('-1'), STATEMENT_TIMEOUT_MS_DEFAULT);
});

test('statement timeout: out-of-range, fractional and non-numeric values fall back to the default', () => {
  const refused = [
    '',            // blank, i.e. the shipped .env.example placeholder
    '   ',
    'abc',
    '10s',         // a unit suffix this variable does not accept (it is milliseconds)
    '99',          // below the floor
    String(STATEMENT_TIMEOUT_MS_MIN - 1),
    String(STATEMENT_TIMEOUT_MS_MAX + 1),
    '600000000',   // a plausible ms/seconds mix-up: 6.9 days
    '1500.5',      // fractional
    '1e9',
    'Infinity',
    'NaN',
  ];
  for (const raw of refused) {
    assert.equal(statementTimeoutMs(raw), STATEMENT_TIMEOUT_MS_DEFAULT, `"${raw}" must be ignored`);
  }
});

test('statement timeout: an in-range value is honoured, at both bounds', () => {
  assert.equal(statementTimeoutMs('250'), 250);
  assert.equal(statementTimeoutMs(String(STATEMENT_TIMEOUT_MS_MIN)), STATEMENT_TIMEOUT_MS_MIN);
  assert.equal(statementTimeoutMs(String(STATEMENT_TIMEOUT_MS_MAX)), STATEMENT_TIMEOUT_MS_MAX);
  assert.equal(statementTimeoutMs('30000'), 30_000);
});

test('statement timeout: the value the env configures is the one the pool is built with', () => {
  const options = sqlClientOptions();
  assert.equal(typeof options.connection, 'object');
  assert.equal(
    (options.connection as { statement_timeout?: number }).statement_timeout,
    statementTimeoutMs(),
    'getSql() must send the configured statement_timeout as a connection parameter',
  );
});

test('statement timeout: the rest of the pool contract is unchanged by this option', () => {
  // Guard against a refactor quietly dropping one of the pre-existing limits
  // while adding this one.
  const options = sqlClientOptions();
  assert.equal(options.max, 10);
  assert.equal(options.idle_timeout, 20);
  assert.equal(options.connect_timeout, 5);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHuman,
  formatStructured,
  pickFields,
  structuredLogging,
  type LogOptions,
} from '../../src/lib/logger';

/**
 * The logger's contract, asserted on the pure formatters rather than through a
 * console stub: a stub would test the stub, and the line a log pipeline ingests
 * is exactly `formatStructured`'s return value.
 */

const FIXED_NOW = new Date('2026-09-20T12:00:00.000Z');

function parse(line: string): Record<string, unknown> {
  // A single physical line is the point: no embedded newline may survive into a
  // line-oriented log, even though a stack trace contains plenty.
  assert.equal(line.includes('\n'), false, 'a log record must be one line');
  return JSON.parse(line) as Record<string, unknown>;
}

test('logger: the production record is one line of JSON with level, msg and ts', () => {
  const line = formatStructured('warn', 'outbox lag unavailable', { event: 'outbox_lag' }, FIXED_NOW);
  const record = parse(line);
  assert.equal(record.level, 'warn');
  assert.equal(record.msg, 'outbox lag unavailable');
  assert.equal(record.ts, FIXED_NOW.toISOString());
  assert.equal(record.event, 'outbox_lag');
  assert.deepEqual(Object.keys(record).sort(), ['event', 'level', 'msg', 'ts']);
});

test('logger: every whitelisted field survives, with its type', () => {
  const options: LogOptions = {
    correlation_id: '2f1c4c1e-0000-4000-8000-000000000000',
    event: 'worker_tick',
    job_id: 'b3f1c0de-0000-4000-8000-000000000001',
    job_kind: 'outbound_notification',
    outcome: 'suppressed',
    code: 'channel_disabled',
    provider: 'telegram',
    email_provider: 'resend',
    status: 502,
    attempt: 2,
    count: 3,
    requeued: 1,
    retryable: false,
  };
  const record = parse(formatStructured('info', 'tick', options, FIXED_NOW));
  for (const [key, value] of Object.entries(options)) {
    assert.equal(record[key], value, `${key} must survive verbatim`);
  }
});

test('logger: a non-whitelisted field is DROPPED — the PII guard', () => {
  // The shape a careless call site would write. `as LogOptions` is the point:
  // the interface stops this at compile time, and the runtime filter stops it
  // anyway (a cast, a spread, a JS caller).
  const smuggled = {
    event: 'otp_requested',
    email: 'someone@example.org',
    phone: '+34600111222',
    body: { password: 'hunter2' },
    authorization: 'Bearer secret-token',
  } as unknown as LogOptions;

  const line = formatStructured('info', 'otp requested', smuggled, FIXED_NOW);
  const record = parse(line);
  assert.deepEqual(Object.keys(record).sort(), ['event', 'level', 'msg', 'ts']);
  for (const forbidden of ['someone@example.org', '+34600111222', 'hunter2', 'secret-token', 'email', 'phone', 'body']) {
    assert.equal(line.includes(forbidden), false, `${forbidden} must not reach the log line`);
  }
  assert.equal(pickFields(smuggled).email, undefined);
});

test('logger: a non-scalar value under an allowed key is dropped too', () => {
  // 'job_id' IS allowed — but only as a scalar. A row or payload assigned to it
  // must not be serialized just because the key is trusted.
  const options = { job_id: { payload: 'contact value' } } as unknown as LogOptions;
  const line = formatStructured('error', 'job failed', options, FIXED_NOW);
  const record = parse(line);
  assert.equal(record.job_id, undefined);
  assert.equal(line.includes('contact value'), false);
});

test('logger: a caught value keeps its name, message and stack inside the one line', () => {
  const err = new Error('HASH_PEPPER is not configured');
  const line = formatStructured('error', '[internal_error]', { event: 'internal_error', err }, FIXED_NOW);
  const record = parse(line);
  const serialized = record.err as { name: string; message: string; stack?: string };
  assert.equal(serialized.name, 'Error');
  assert.equal(serialized.message, 'HASH_PEPPER is not configured');
  assert.equal(typeof serialized.stack, 'string');
  // `err` is a caught value, not a field: it is never copied into the envelope.
  assert.equal(record.err && typeof record.err, 'object');
  // The operator can still grep the line for the cause (see
  // tests/unit/required-config.test.ts, which asserts exactly that).
  assert.ok(line.includes('HASH_PEPPER is not configured'));
});

test('logger: a non-Error value is never serialized wholesale', () => {
  const line = formatStructured('error', 'failed', { err: { email: 'someone@example.org' } }, FIXED_NOW);
  const serialized = parse(line).err as { name: string; message: string };
  assert.equal(serialized.name, 'NonError');
  assert.match(serialized.message, /non-error value of type object/);
  assert.equal(line.includes('someone@example.org'), false);

  // A string error (explicit caller intent) is kept as the message.
  assert.equal((parse(formatStructured('error', 'failed', { err: 'boom' }, FIXED_NOW)).err as { message: string }).message, 'boom');

  // No caught value → no `err` key at all.
  assert.equal('err' in parse(formatStructured('error', 'failed', { event: 'x' }, FIXED_NOW)), false);
});

test('logger: development output is not JSON and keeps the message first', () => {
  const args = formatHuman('[enrich] provider failed', {
    event: 'enrichment_provider_failed',
    provider: 'vertex_gemini',
    code: 'upstream_5xx',
    err: new Error('boom'),
  });
  assert.equal(args.length, 2);
  const line = args[0] as string;
  assert.equal(line.startsWith('[enrich]'), true, 'the prefix existing tests assert on must stay first');
  assert.ok(line.includes('provider=vertex_gemini'));
  assert.ok(line.includes('code=upstream_5xx'));
  assert.doesNotMatch(line, /^\{/, 'development output is not JSON');
  // The caught value is NOT rendered as `err=…` in the human line — it is passed
  // through as the raw object, so a terminal shows the stack.
  assert.equal(line.includes('err='), false);
  assert.ok(args[1] instanceof Error, 'the raw error is passed through for the stack');
});

test('logger: warning-level call sites keep their caught value too', () => {
  // `health` and the webhook fast path warn WITH an error; the shape must not
  // lose it just because the level is not `error`.
  const args = formatHuman('[health] outbox lag unavailable', { event: 'outbox_lag_unavailable', err: new Error('down') });
  assert.equal(args.length, 2);
  assert.ok(args[1] instanceof Error);
  const structured = parse(formatStructured('warn', '[health] outbox lag unavailable', { event: 'outbox_lag_unavailable', err: new Error('down') }, FIXED_NOW));
  assert.equal((structured.err as { message: string }).message, 'down');
});

test('logger: the format follows the environment, not the call site', () => {
  // `process.env` is typed read-only in @types/node (assigning to NODE_ENV is a
  // compile error) — the cast is what the runtime actually allows.
  const env = process.env as unknown as Record<string, string | undefined>;
  const saved = { node: env.NODE_ENV, app: env.APP_ENV };
  try {
    delete env.NODE_ENV;
    delete env.APP_ENV;
    assert.equal(structuredLogging(), false, 'a plain `pnpm worker` in development logs human-readable text');
    env.APP_ENV = 'production';
    assert.equal(structuredLogging(), true, 'a production worker without NODE_ENV still logs JSON');
    env.APP_ENV = 'development';
    env.NODE_ENV = 'production';
    assert.equal(structuredLogging(), true, 'Next production runtime / client bundle');
  } finally {
    if (saved.node === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = saved.node;
    if (saved.app === undefined) delete env.APP_ENV;
    else env.APP_ENV = saved.app;
  }
});

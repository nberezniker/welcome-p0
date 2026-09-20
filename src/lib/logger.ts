/**
 * One logger for the whole app.
 *
 * WHY IT EXISTS. Production logs were `console.error('[internal_error] …', err)`
 * at ~21 call sites, each with its own hand-rolled prefix. That is fine to read
 * and impossible to query: no field can be filtered or aggregated, and every
 * site is free to print whatever object it happens to hold. This module makes a
 * log line a RECORD with a fixed envelope and a closed set of fields, and it
 * makes the shape of that record a thing a test can assert.
 *
 * TWO FORMATS, ONE SINK:
 *   - production → one line of JSON: `level`, `msg`, `ts`, the whitelisted
 *     fields, and `err` when there is one. `JSON.stringify` escapes newlines, so
 *     a stack trace stays a single physical line — which is the whole point of
 *     a line-oriented log (one event = one line).
 *   - everywhere else → the shape this codebase already had:
 *     `console[level](msg, key=value …, err)`. Deliberately NOT prefixed with a
 *     level: the console method already carries it, and three existing tests
 *     assert on today's text (`[enrich] … provider=… code=…`,
 *     `[otp-exposure] …`, the `HASH_PEPPER is not configured` line). Keeping
 *     development identical to what the repo already emitted means the
 *     migration changed production — which was the goal — and nothing else.
 *
 * WHY `process.env` DIRECTLY, and not `isProduction()` from src/lib/env.ts:
 * this module is imported by the CLIENT error boundary (src/app/error.tsx), and
 * src/lib/env.ts pulls in src/lib/crypto.ts (`node:crypto`) for its OTP
 * allowlist parsing. Importing it here would drag Node built-ins into the
 * browser bundle and break the build. Reading the two variables directly keeps
 * this file dependency-FREE, which is also what makes it testable in isolation.
 * Both are legitimately global: NODE_ENV is set by Next for both graphs (and
 * inlined in the client bundle), APP_ENV covers a long-running worker started
 * without the framework (`pnpm worker`).
 *
 * WHAT NEVER GETS LOGGED: no contact value (email, phone, WhatsApp, Telegram
 * handle), no session or OTP token, no cookie, no request body, no user text.
 * That is enforced structurally rather than by discipline: `LogFields` is a
 * closed interface, and `pickFields` drops any key not on the allow-list below,
 * so `log.info('x', { email })` writes a line WITHOUT the address even if a
 * future call site tries it. The allow-list and its reasons:
 *
 *   correlation_id  the uuid the caller also receives in the JSON error body —
 *                   the ONLY way to join a user's report to its log line
 *   event           a fixed label chosen in code ('worker_tick', …)
 *   job_id          opaque outbox uuid; the worker runbook needs it
 *   job_kind        fixed outbox kind ('outbound_notification', …)
 *   outcome         fixed outcome enum from the tick/transport report
 *   code            fixed error-code enum ('upstream_5xx', 'channel_disabled')
 *   provider        fixed registry id ('telegram', 'vertex_gemini')
 *   email_provider  the outbound EMAIL transport resolved for this worker
 *                   ('resend', 'disabled', 'none') — the second half of the pair
 *                   the worker reports at startup
 *   status          HTTP or upstream status (number)
 *   attempt         retry ordinal (number)
 *   count           how many items the line is about (number)
 *   requeued        leases requeued by a worker tick (number)
 *   retryable       boolean from the transport report
 *
 * Values must be scalars: an object (a body, a row, a payload) is dropped, so a
 * well-meaning `{ job_id: someRow }` cannot smuggle one in. A caught value is
 * passed as `options.err` — recognised at every level, never a whitelisted field,
 * and never serialized wholesale (see `serializeError`). One options object for
 * every call rather than a positional error argument: `log.error('x', err)` on a
 * `(msg, fields?, err?)` signature would type-check (every field is optional) and
 * then silently drop the error, which is exactly the footgun this file exists to
 * avoid.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The only fields that can ever reach a log line. See the header comment. */
export interface LogFields {
  correlation_id?: string;
  event?: string;
  job_id?: string;
  job_kind?: string;
  outcome?: string;
  code?: string;
  provider?: string;
  email_provider?: string;
  status?: number;
  attempt?: number;
  count?: number;
  requeued?: number;
  retryable?: boolean;
}

/** Whitelisted fields plus the one non-field: the caught value. */
export interface LogOptions extends LogFields {
  /**
   * The thrown value, when there is one. Not a field — it is reduced to
   * `{name, message, stack?}` by `serializeError` and emitted as `err`, so an
   * arbitrary object can never be dumped just by landing here.
   */
  err?: unknown;
}

const ALLOWED_FIELDS: ReadonlySet<string> = new Set<keyof LogFields>([
  'correlation_id',
  'event',
  'job_id',
  'job_kind',
  'outcome',
  'code',
  'provider',
  'email_provider',
  'status',
  'attempt',
  'count',
  'requeued',
  'retryable',
]);

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Keeps the allow-listed, scalar-valued fields and drops everything else.
 * Exported because the shape of a production line is asserted by
 * tests/unit/logger.test.ts, and asserting it through a `console` stub would
 * test the stub as much as the logger.
 */
export function pickFields(fields?: LogFields): Record<string, Scalar> {
  const picked: Record<string, Scalar> = {};
  if (!fields) return picked;
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (!isScalar(value)) continue;
    picked[key] = value;
  }
  return picked;
}

/**
 * An error, reduced to what a log line needs. The stack is included ON PURPOSE:
 * logs are server-side, a 500 without a stack is not debuggable, and the same
 * stack is already refused to callers (src/lib/http.ts `internalError` returns a
 * sanitized body). A non-Error value keeps only its string form — an arbitrary
 * object (a request body, a DB row) is reported as a type, never serialized,
 * because "log the thing that broke" is exactly how a body ends up in a log.
 */
function serializeError(err: unknown): { name: string; message: string; stack?: string } | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) {
    const serialized: { name: string; message: string; stack?: string } = {
      name: err.name,
      message: err.message,
    };
    if (err.stack) serialized.stack = err.stack;
    return serialized;
  }
  if (typeof err === 'string') return { name: 'NonError', message: err };
  return { name: 'NonError', message: `non-error value of type ${typeof err}` };
}

/** True when this process should emit the machine-readable format. */
export function structuredLogging(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';
}

/** The single-line production record. Pure, so a test can assert it directly. */
export function formatStructured(
  level: LogLevel,
  msg: string,
  options?: LogOptions,
  now: Date = new Date(),
): string {
  const record: Record<string, unknown> = { level, msg, ts: now.toISOString(), ...pickFields(options) };
  const serialized = serializeError(options?.err);
  if (serialized) record.err = serialized;
  return JSON.stringify(record);
}

/**
 * The development shape: the message with its fields appended as `key=value`,
 * then the raw error (so a terminal shows the stack). Byte-compatible with what
 * these call sites printed before this module existed — deliberately, because it
 * is the shape three existing tests assert on.
 *
 * No level prefix: `console.error`/`console.warn` already colour the line, and a
 * prefix would break the `startsWith('[enrich]')` contract the enrichment test
 * checks. That is also why this one takes no `level`.
 */
export function formatHuman(msg: string, options?: LogOptions): unknown[] {
  const pairs = Object.entries(pickFields(options)).map(([key, value]) => `${key}=${String(value)}`);
  const line = pairs.length > 0 ? `${msg} ${pairs.join(' ')}` : msg;
  const err = options?.err;
  return err === undefined || err === null ? [line] : [line, err];
}

function write(level: LogLevel, args: unknown[]): void {
  // Called inline rather than through an extracted reference: `console`'s methods
  // are bound, but an extra variable is one more thing a bundler can minify
  // wrongly and there is nothing to gain here.
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
}

function emit(level: LogLevel, msg: string, options?: LogOptions): void {
  if (structuredLogging()) write(level, [formatStructured(level, msg, options)]);
  else write(level, formatHuman(msg, options));
}

/**
 * The logger. One options object at every level; pass a caught value as
 * `options.err` so it is serialized once, in one place.
 */
export const log = {
  debug(msg: string, options?: LogOptions): void {
    emit('debug', msg, options);
  },
  info(msg: string, options?: LogOptions): void {
    emit('info', msg, options);
  },
  warn(msg: string, options?: LogOptions): void {
    emit('warn', msg, options);
  },
  error(msg: string, options?: LogOptions): void {
    emit('error', msg, options);
  },
};

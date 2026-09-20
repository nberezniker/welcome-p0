import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { POST as localeRoute } from '../../src/app/api/locale/route';
import { POST as webhookRoute } from '../../src/app/api/webhooks/telegram/route';
import { GET as publicProfileRoute } from '../../src/app/api/public/profiles/[slug]/route';
import { makeRequest, assertStatus } from './helpers';
import { getSql, closeSql } from '../../src/lib/db';
import { enqueueOutbox } from '../../src/infra/outbox';
import { runWithRequestId } from '../../src/lib/request-context';
import { REQUEST_ID_HEADER } from '../../src/lib/request-id';

/**
 * The correlation id, end to end.
 *
 * The claim being tested is narrow and checkable: for ONE request, the id in the
 * error body, the id on the response header, and the id in the log line are the
 * same value — and a malformed inbound id is neither echoed nor logged. Before
 * this suite the id was minted per error RESPONSE, so no other line of the same
 * request could carry it and a user's report resolved to nothing.
 *
 * The log side is asserted by capturing the logger's only sink (console) with
 * APP_ENV=production, so the captured line is the real single-line JSON record a
 * log pipeline would ingest rather than the development text shape.
 */

const sql = getSql();
const WEBHOOK_HEADER = 'integration-telegram-webhook-secret';

after(async () => {
  await closeSql();
});

interface ErrBody {
  code: string;
  message: string;
  correlation_id: string;
  retryable: boolean;
}

/** Runs `fn` with structured logging on and every console call captured. */
async function withStructuredLogs<T>(fn: () => Promise<T>): Promise<{ result: T; records: Record<string, unknown>[] }> {
  const captured: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const sink = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const env = process.env as unknown as Record<string, string | undefined>;
  const savedAppEnv = env.APP_ENV;
  env.APP_ENV = 'production';
  console.log = sink as typeof console.log;
  console.warn = sink as typeof console.warn;
  console.error = sink as typeof console.error;
  console.info = sink as typeof console.info;
  try {
    const result = await fn();
    return { result, records: captured.map((line) => JSON.parse(line) as Record<string, unknown>) };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
    if (savedAppEnv === undefined) delete env.APP_ENV;
    else env.APP_ENV = savedAppEnv;
  }
}

/** A cross-origin mutating POST — the cheapest error response with no DB work. */
function rejectedCrossOrigin(correlationId?: string): Promise<Response> {
  return localeRoute(
    makeRequest('/api/locale', {
      method: 'POST',
      body: { locale: 'ru' },
      headers: {
        origin: 'https://evil.example',
        ...(correlationId === undefined ? {} : { [REQUEST_ID_HEADER]: correlationId }),
      },
    }),
  );
}

test('correlation id: the body, the response header and the log line carry ONE value', async () => {
  const inbound = randomUUID();
  const { result: res, records } = await withStructuredLogs(() => rejectedCrossOrigin(inbound));
  assertStatus(res, 403);

  const body = (await res.json()) as ErrBody;
  assert.equal(body.code, 'csrf_origin');
  // 1. The caller's own well-formed id is reused, so a caller that already has a
  //    trace id keeps it across our boundary.
  assert.equal(body.correlation_id, inbound, 'the body must echo the well-formed inbound id');
  // 2. …and returned on the response itself, which is how a caller finds it on a
  //    2xx response where there is no body field to hold it.
  assert.equal(res.headers.get(REQUEST_ID_HEADER), inbound);

  // 3. The log line for THIS request carries the same value — the whole point.
  const line = records.find((r) => r.event === 'api_error_response');
  assert.ok(line, 'an error response must leave exactly one api_error_response line');
  assert.equal(line.correlation_id, inbound);
  assert.equal(line.status, 403);
  assert.equal(line.code, 'csrf_origin');
  assert.equal(line.retryable, false);
  assert.equal(line.level, 'warn', '4xx is a warning, so 5xx stays alertable');
  assert.equal(
    records.filter((r) => r.event === 'api_error_response').length,
    1,
    'one response → one line, not one line per nested error surface',
  );
});

test('correlation id: a malformed inbound id is replaced and never echoed or logged', async () => {
  // A malformed id that can genuinely arrive over HTTP: a SPACE is legal in a
  // header value, so the transport does not stop this one — the application rule
  // is the only thing that does. (A newline cannot be tested here at all: the
  // Fetch layer refuses to build such a request, which is itself the finding —
  // see the unit suite's defence-in-depth case.)
  const forged = 'forged-id 0000 [api] error response correlation_id=deadbeefcafe';
  const { result: res, records } = await withStructuredLogs(() => rejectedCrossOrigin(forged));
  assertStatus(res, 403);

  const body = (await res.json()) as ErrBody;
  assert.notEqual(body.correlation_id, forged, 'a malformed inbound id must NOT be echoed');
  assert.match(body.correlation_id, /^[0-9a-f-]{36}$/, 'the replacement is one of ours');
  assert.equal(res.headers.get(REQUEST_ID_HEADER), body.correlation_id);

  const line = records.find((r) => r.event === 'api_error_response');
  assert.ok(line);
  assert.equal(line.correlation_id, body.correlation_id);
  // Nothing from the rejected value survives anywhere — this is the assertion
  // that makes the charset rule worth its keep.
  for (const record of records) {
    const serialized = JSON.stringify(record);
    assert.equal(serialized.includes('deadbeefcafe'), false, 'the rejected value must not reach a log record');
  }
});

test('correlation id: the sentinel values a client sends with no id are not honoured', async () => {
  // `undefined`/`null` pass a naive charset check but are the SAME value for every
  // such request, so accepting them would collapse many requests into one trace
  // id. Each gets its own generated id instead.
  const seen = new Set<string>();
  for (const sentinel of ['undefined', 'null']) {
    const res = await rejectedCrossOrigin(sentinel);
    assertStatus(res, 403);
    const body = (await res.json()) as ErrBody;
    assert.notEqual(body.correlation_id, sentinel);
    seen.add(body.correlation_id);
  }
  assert.equal(seen.size, 2, 'two requests must not share one id');
});

test('correlation id: no inbound id at all → one is generated, and used consistently', async () => {
  const { result: res, records } = await withStructuredLogs(() => rejectedCrossOrigin());
  assertStatus(res, 403);
  const body = (await res.json()) as ErrBody;
  assert.match(body.correlation_id, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers.get(REQUEST_ID_HEADER), body.correlation_id);
  assert.equal(records.find((r) => r.event === 'api_error_response')?.correlation_id, body.correlation_id);
});

test('correlation id: a route that takes no guard still carries the request id', async () => {
  // The public profile projection is a read-only GET: it is wrapped in
  // withRequestContext ONLY (no CSRF check, no rate limit), so this is the case
  // the 19 unwrapped routes represented. A 404 for an unknown slug needs no
  // fixtures, which is exactly why it is the vehicle here.
  const inbound = randomUUID();
  const { result: res, records } = await withStructuredLogs(() =>
    publicProfileRoute(
      makeRequest(`/api/public/profiles/no-such-slug-${randomUUID()}`, {
        headers: { [REQUEST_ID_HEADER]: inbound },
      }),
      { params: Promise.resolve({ slug: 'unused' }) },
    ),
  );
  assertStatus(res, 404);
  const body = (await res.json()) as ErrBody;
  assert.equal(body.code, 'not_found');
  assert.equal(body.correlation_id, inbound);
  assert.equal(res.headers.get(REQUEST_ID_HEADER), inbound);
  assert.equal(records.find((r) => r.event === 'api_error_response')?.correlation_id, inbound);
});

// ---------------------------------------------------------------------------
// The id travels with the work it enqueues (migration 015).
// ---------------------------------------------------------------------------

let seq = 9_000_000 + (Date.now() % 100_000);
function nextUpdateId(): number {
  return (seq += 1);
}

test('correlation id: an outbox job carries the id of the request that enqueued it', async () => {
  // Driven through the REAL webhook route: no account fixtures are needed for a
  // message update (the accept path enqueues the work; the worker handles it
  // later or not at all within this test), so the assertion is about the request
  // → job link and nothing else.
  const inbound = randomUUID();
  const updateId = nextUpdateId();
  const res = await webhookRoute(
    makeRequest('/api/webhooks/telegram', {
      body: {
        update_id: updateId,
        message: { message_id: updateId, from: { id: 424242 }, chat: { id: 424242 }, text: '/start' },
      },
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_HEADER, [REQUEST_ID_HEADER]: inbound },
    }),
  );
  assertStatus(res, 200);
  assert.equal(res.headers.get(REQUEST_ID_HEADER), inbound, 'the response carries the request id too');

  const rows = await sql<{ id: string; correlation_id: string | null }[]>`
    SELECT id, correlation_id FROM outbox_jobs WHERE dedupe_key = ${`tg_update:${updateId}`}
  `;
  assert.equal(rows.length, 1, 'the webhook must have enqueued exactly one job');
  assert.equal(
    rows[0]!.correlation_id,
    inbound,
    'the job must be traceable to the request that created it',
  );

  // The runbook query from migration 015 must find it by the id alone.
  const byTrace = await sql<{ id: string }[]>`SELECT id FROM outbox_jobs WHERE correlation_id = ${inbound}`;
  assert.equal(byTrace.length, 1);
  assert.equal(byTrace[0]!.id, rows[0]!.id);

  await sql`DELETE FROM outbox_jobs WHERE id = ${rows[0]!.id}`;
});

test('correlation id: work enqueued OUTSIDE a request is NULL, not a fabricated id', async () => {
  // The worker enqueues jobs itself (the Phase-4 follow-up scan). Inventing an id
  // there would produce a value that looks greppable and matches nothing, so the
  // column is left empty and the operator sees "no request behind this job".
  const insideKey = `corr-inside:${randomUUID()}`;
  const outsideKey = `corr-outside:${randomUUID()}`;

  const inside = await runWithRequestId('test-request-id-0001', () =>
    enqueueOutbox(sql, {
      dedupeKey: insideKey,
      kind: 'telegram_reply',
      subjectId: null,
      channel: 'telegram',
      purpose: 'service_channel',
      payload: {},
    }),
  );
  const outside = await enqueueOutbox(sql, {
    dedupeKey: outsideKey,
    kind: 'telegram_reply',
    subjectId: null,
    channel: 'telegram',
    purpose: 'service_channel',
    payload: {},
  });

  const rows = await sql<{ id: string; correlation_id: string | null }[]>`
    SELECT id, correlation_id FROM outbox_jobs WHERE id IN ${sql([inside.id, outside.id])}
  `;
  const byId = new Map(rows.map((r) => [r.id, r.correlation_id]));
  assert.equal(byId.get(inside.id), 'test-request-id-0001', 'an ambient request id is persisted');
  assert.equal(byId.get(outside.id), null, 'no request → no id');

  await sql`DELETE FROM outbox_jobs WHERE id IN ${sql([inside.id, outside.id])}`;
});

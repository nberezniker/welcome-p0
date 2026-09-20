import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isTimeoutError,
  timeoutSignal,
  type FetchLike,
} from '../../src/lib/outbound';
import { ResendEmailTransport } from '../../src/integrations/email/transport';
import { TelegramTransport } from '../../src/integrations/telegram/transport';
import { VertexEnrichmentTransport } from '../../src/integrations/enrichment/transport';

/**
 * Every outbound HTTP call this app makes is BOUNDED, and a timeout is reported
 * as a timeout.
 *
 * WHAT WAS WRONG BEFORE THIS SUITE. All four providers (Resend, Telegram, Google,
 * Vertex) already carried an `AbortSignal.timeout(...)`, but nothing proved it:
 * the transports took the global `fetch`, so a test could only observe the bound
 * by hanging the request for the real 10–30 seconds, which no gate will do. A
 * budget nobody can assert is a budget that quietly disappears in a refactor.
 * The transports now take an injectable transport function and an injectable
 * budget (src/lib/outbound.ts), which is what makes the bound cheap to prove
 * here — and the injection exists for tests only; production constructs these
 * with the defaults and there is no env var that changes them.
 *
 * The ONE defect this found: the enrichment transport passed its REMAINING
 * budget straight to `AbortSignal.timeout`, which throws a RangeError for a
 * non-positive value; that exception was caught by the same handler that
 * classifies transport failures and reported as `network_error`. An exhausted
 * deadline is now reported as `timeout`, and the call is not attempted.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A transport that never answers, rejecting when the caller's signal fires —
 * exactly what the real fetch does on a mid-flight timeout (verified on this
 * runtime: a hanging connection rejects with a DOMException named TimeoutError). */
function hangingTransport(): FetchLike {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        // No signal → nothing can ever end this call. Rejecting immediately is
        // what turns "the caller forgot the bound" into a visible failure rather
        // than a hung test, and no test below reaches this branch.
        reject(new Error('UNBOUNDED_CALL'));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

/** A transport that fails the way a refused connection does: a plain TypeError. */
function refusedTransport(): FetchLike {
  return async () => {
    throw new TypeError('fetch failed');
  };
}

/**
 * Holds the event loop open for the duration of a hung call.
 *
 * WHY THIS IS NEEDED: `AbortSignal.timeout`'s timer is UNREF'd, so it does not by
 * itself keep the process alive — in a program whose only pending work is that
 * timer, Node exits before it fires, and node:test reports "Promise resolution is
 * still pending but the event loop has already resolved". A real deployment is
 * never in that state (a request handler or the worker loop always has other work
 * pending), so this is a property of the test harness rather than of the
 * transports — but the test has to account for it, and accounting for it beats
 * weakening the assertion to "some error happened".
 */
function keepEventLoopAlive(): { stop: () => void } {
  const timer = setInterval(() => {}, 5);
  return { stop: () => clearInterval(timer) };
}

/** Runs `fn` with the event loop held open. */
async function withLiveEventLoop<T>(fn: () => Promise<T>): Promise<T> {
  const keepAlive = keepEventLoopAlive();
  try {
    return await fn();
  } finally {
    keepAlive.stop();
  }
}

const ENRICHMENT_OPTIONS = {
  projectId: 'unit-project',
  location: 'us-central1',
  model: 'gemini-2.5-flash',
  tokenSource: { kind: 'gcp_access_token' as const, getToken: async () => 'unit-token' },
};

const ENRICHMENT_REQUEST = { displayName: 'Ada Lovelace', company: null, industry: null, links: [] };

// ---------------------------------------------------------------------------
// The mechanism
// ---------------------------------------------------------------------------

test('outbound: only a TimeoutError is a timeout — a refused connection is not', () => {
  assert.equal(isTimeoutError(new DOMException('x', 'TimeoutError')), true);
  // What a refused connection / DNS failure actually rejects with (measured):
  // `fetch` throws a TypeError. Reporting that as 'timeout' would blame our own
  // budget for the network, and vice versa.
  assert.equal(isTimeoutError(new TypeError('fetch failed')), false);
  assert.equal(isTimeoutError(new DOMException('x', 'AbortError')), false);
  assert.equal(isTimeoutError(new RangeError('out of range')), false);
  assert.equal(isTimeoutError('timeout'), false);
  assert.equal(isTimeoutError(undefined), false);
});

test('outbound: timeoutSignal is total — no argument can make it throw', async () => {
  // The bug this prevents: AbortSignal.timeout(-5) throws a RangeError
  // synchronously, from inside the try that classifies transport failures.
  for (const ms of [-5, 0, -0.5, Number.NaN, Number.NEGATIVE_INFINITY, 0.4]) {
    const signal = timeoutSignal(ms);
    assert.ok(signal instanceof AbortSignal, `timeoutSignal(${ms}) must return a signal`);
    // The smallest real delay: it fires, and it fires as a TimeoutError.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(signal.aborted, true, `timeoutSignal(${ms}) must abort`);
    assert.equal(isTimeoutError(signal.reason), true);
  }

  // A positive budget is honoured rather than collapsed to the floor.
  const live = timeoutSignal(60_000);
  assert.equal(live.aborted, false);
});

// ---------------------------------------------------------------------------
// Each transport: bounded, and honest about which failure this was
// ---------------------------------------------------------------------------

test('telegram: a hanging send ends at the injected bound as a typed timeout', async () => {
  const transport = new TelegramTransport('12345:token', { fetchImpl: hangingTransport(), timeoutMs: 25 });
  const started = Date.now();
  const result = await withLiveEventLoop(() => transport.send({ jobId: 'j', chatId: '42', text: 'hi' }));
  assert.equal(result.state, 'unknown');
  assert.equal(result.code, 'timeout');
  assert.ok(Date.now() - started < 5_000, 'the injected bound must be what ended the call');
});

test('telegram: a refused connection is reported as network_error, not timeout', async () => {
  const transport = new TelegramTransport('12345:token', { fetchImpl: refusedTransport() });
  const result = await transport.send({ jobId: 'j', chatId: '42', text: 'hi' });
  assert.equal(result.state, 'unknown');
  assert.equal(result.code, 'network_error');
});

test('email: a hanging send ends at the injected bound as a typed timeout', async () => {
  const transport = new ResendEmailTransport('re_unit_key', 'WELCOME <noreply@example.test>', {
    fetchImpl: hangingTransport(),
    timeoutMs: 25,
  });
  const started = Date.now();
  const result = await withLiveEventLoop(() => transport.send({ to: 'unit@example.test', subject: 's', text: 't' }));
  assert.equal(result.state, 'unknown');
  assert.equal(result.code, 'timeout');
  assert.ok(Date.now() - started < 5_000);
});

test('email: a refused connection is reported as network_error, not timeout', async () => {
  const transport = new ResendEmailTransport('re_unit_key', 'WELCOME <noreply@example.test>', {
    fetchImpl: refusedTransport(),
  });
  const result = await transport.send({ to: 'unit@example.test', subject: 's', text: 't' });
  assert.equal(result.code, 'network_error');
});

test('enrichment: a hanging call ends at the injected bound as a typed, retryable timeout', async () => {
  const transport = new VertexEnrichmentTransport(ENRICHMENT_OPTIONS, {
    fetchImpl: hangingTransport(),
    timeoutMs: 25,
  });
  const started = Date.now();
  const result = await withLiveEventLoop(() => transport.enrich(ENRICHMENT_REQUEST));
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'timeout');
  assert.equal(result.retryable, true, 'a timeout is worth retrying — the route degrades on it');
  assert.ok(Date.now() - started < 5_000);
});

test('enrichment: a SPENT deadline is a timeout and the call is never attempted', async () => {
  // The defect this pins: the remaining budget went straight into
  // AbortSignal.timeout, a non-positive value threw a RangeError from inside the
  // transport catch, and the outcome was reported as `network_error` — a call
  // that was never made, blamed on the network.
  let calls = 0;
  const transport = new VertexEnrichmentTransport(ENRICHMENT_OPTIONS, {
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    },
    timeoutMs: 0,
  });
  const result = await transport.enrich(ENRICHMENT_REQUEST);
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'timeout');
  assert.equal(result.retryable, true);
  assert.equal(calls, 0, 'an exhausted budget must not spend a request');
});

test('enrichment: a refused connection is reported as network_error, not timeout', async () => {
  const transport = new VertexEnrichmentTransport(ENRICHMENT_OPTIONS, { fetchImpl: refusedTransport() });
  const result = await transport.enrich(ENRICHMENT_REQUEST);
  assert.equal(result.code, 'network_error');
  assert.equal(result.retryable, true);
});

test('every transport hands its outbound call a live deadline signal', async () => {
  // The property behind all of the above: no call goes out without a signal, and
  // the signal is not already dead when the call starts.
  const seen: (AbortSignal | null | undefined)[] = [];
  // A USABLE answer, not an empty 200: the enrichment transport makes exactly one
  // internal retry when the model returns no parsable draft (its documented
  // behaviour), and this test is about the signal, not about the retry.
  const draft = JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            {
              text: '{"headline":"Ada","short_bio":null,"company":null,"links":[],"suggested_interests":[],"suggested_intents":[]}',
            },
          ],
        },
      },
    ],
  });
  const recording: FetchLike = (input, init) => {
    seen.push(init?.signal);
    return Promise.resolve(new Response(draft, { status: 200 }));
  };

  await new TelegramTransport('12345:token', { fetchImpl: recording }).send({ jobId: 'j', chatId: '1', text: 't' });
  await new ResendEmailTransport('re_unit_key', 'WELCOME <noreply@example.test>', { fetchImpl: recording }).send({
    to: 'unit@example.test',
    subject: 's',
    text: 't',
  });
  await new VertexEnrichmentTransport(ENRICHMENT_OPTIONS, { fetchImpl: recording }).enrich(ENRICHMENT_REQUEST);

  assert.equal(seen.length, 3, 'one outbound call per transport');
  for (const signal of seen) {
    assert.ok(signal instanceof AbortSignal, 'the call must carry a signal');
    assert.equal(signal.aborted, false, 'the deadline must not already have fired');
  }
});

// ---------------------------------------------------------------------------
// The audit: no outbound call site may exist without a bound
// ---------------------------------------------------------------------------

/**
 * Every module that performs off-host HTTP, with the number of outbound calls it
 * makes. The allow-list itself is enforced separately (tests/unit/static-safety
 * .test.ts pins WHICH files may reach which host); this test pins that each of
 * those call sites carries a deadline.
 */
const OUTBOUND_MODULES: { file: string; calls: number }[] = [
  { file: 'src/integrations/email/transport.ts', calls: 1 },
  { file: 'src/integrations/telegram/transport.ts', calls: 1 },
  { file: 'src/integrations/enrichment/transport.ts', calls: 1 },
  // Google keeps its own transport seam (setGoogleFetch) and its own 10s bound
  // rather than the shared helper: its five operations share one `callGoogle`
  // wrapper, which is already the single place a signal is attached.
  { file: 'src/lib/google-api.ts', calls: 1 },
];

test('outbound audit: every off-host call site carries a signal, and none is unbounded', () => {
  const findings: string[] = [];

  for (const { file, calls } of OUTBOUND_MODULES) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    // Count only the calls that actually go out: an awaited transport call.
    // (Declarations and the default `fetch` wrapper are not awaited calls.)
    const awaited = source.match(/\bawait\s+(?:this\.fetchImpl|transport|fetch)\s*\(/g) ?? [];
    const signals = source.match(/\bsignal:\s*/g) ?? [];
    if (awaited.length !== calls) {
      findings.push(`${file}: expected ${calls} outbound call(s), found ${awaited.length} — update this audit deliberately`);
    }
    if (signals.length !== awaited.length) {
      findings.push(`${file}: ${awaited.length} outbound call(s) but ${signals.length} signal(s) — an unbounded call can hold a request or a tick forever`);
    }
    if (!/\b(?:timeoutSignal|AbortSignal\.timeout)\s*\(/.test(source)) {
      findings.push(`${file}: no timeout mechanism found`);
    }
    // The budget is a named constant, and it is a real number of milliseconds.
    const budget = /TIMEOUT_MS\s*=\s*([\d_]+)/.exec(source);
    if (!budget) findings.push(`${file}: no *_TIMEOUT_MS constant`);
    else if (!(Number(budget[1]!.replace(/_/g, '')) > 0)) findings.push(`${file}: budget ${budget[1]} is not a positive number`);
  }

  assert.deepEqual(findings, []);
});

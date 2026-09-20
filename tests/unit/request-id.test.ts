import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_ID_HEADER,
  isWellFormedRequestId,
  newRequestId,
  resolveRequestId,
} from '../../src/lib/request-id';

/**
 * The identity rules of a request id. These are pure functions on purpose: the
 * decision "reuse or replace" is the single thing both src/proxy.ts and
 * src/lib/request-context.ts depend on, and a log-injection surface is much
 * better pinned here than discovered in a log pipeline.
 */

const INBOUND = '4f2c1a9e-2f6b-4c1e-9a1d-2b3c4d5e6f70';

test('request id: the header name is the documented one', () => {
  assert.equal(REQUEST_ID_HEADER, 'x-request-id');
});

test('request id: a well-formed inbound id is reused verbatim', () => {
  for (const value of [
    INBOUND, // uuid (what this app generates)
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', // traceparent
    'req_01H8XYZABCDEF', // ULID-shaped
    'aaaaaaaa', // the minimum length
  ]) {
    assert.equal(isWellFormedRequestId(value), true, `${value} must be accepted`);
    assert.equal(resolveRequestId(value), value, `${value} must be echoed, not replaced`);
  }
});

test('request id: every malformed shape is replaced, never echoed', () => {
  // Shapes that can ACTUALLY arrive in a header: a space is legal in a header
  // value, so is a quote, and nothing stops a caller from sending a 4 KB one.
  const rejected: (string | null | undefined)[] = [
    null,
    undefined,
    '',
    '    ', // whitespace only
    'short', // 5 chars — below the floor; a guessed id must not be honoured
    'a'.repeat(129), // above the ceiling: one caller must not bloat every line
    'has space', // space — transmittable, so this is the real-world junk case
    'has\ttab', // HTAB is legal in a header value too
    'quote"break', // would break a `key=value` human line
    'brace}break',
    'semi;colon',
    'null', // the sentinels a client sends when it has no id
    'undefined',
    'NULL',
    'undefined ',
    '../../../etc/passwd', // slash is not in the charset (path-shaped junk)
  ];
  for (const value of rejected) {
    assert.equal(isWellFormedRequestId(value), false, `${JSON.stringify(value)} must be rejected`);
    const resolved = resolveRequestId(value);
    assert.notEqual(resolved, value);
    assert.equal(isWellFormedRequestId(resolved), true, 'the replacement must itself be well-formed');
  }
});

test('request id: a generated id round-trips through the well-formed check', () => {
  // Otherwise "generate, then validate" would be a loop that never accepts its
  // own output — the property that lets both layers agree without sharing state.
  for (let i = 0; i < 50; i += 1) {
    const id = newRequestId();
    assert.equal(isWellFormedRequestId(id), true);
    assert.equal(resolveRequestId(id), id);
  }
  assert.notEqual(newRequestId(), newRequestId(), 'ids must be unique');
});

test('request id: a newline is refused by this layer AND by the platform below it', () => {
  // Defence in depth, and worth naming precisely because it is easy to
  // overstate. The DEVELOPMENT log format writes `${msg} key=value` through
  // `console[level]` with no escaping (src/lib/logger.ts `formatHuman`), so a
  // control character in a value this app echoes would forge a log line — that
  // is why the charset is strict here rather than "reasonably permissive".
  //
  // But such a value cannot reach us in a real request in the first place: the
  // Fetch/HTTP layer rejects a header value containing a newline, so the
  // transport refuses it before any application code runs (the integration suite
  // hits exactly that, because a test cannot even BUILD such a request). Two
  // layers, one of which is not ours to rely on.
  const forged = 'abcdefgh\n[api] error response correlation_id=deadbeefcafe';
  assert.throws(() => new Headers({ [REQUEST_ID_HEADER]: forged }), 'the platform must refuse a newline in a header value');

  assert.equal(isWellFormedRequestId(forged), false);
  const resolved = resolveRequestId(forged);
  assert.equal(resolved.includes('\n'), false);
  assert.equal(resolved.includes('deadbeef'), false, 'nothing from the rejected value may survive into the replacement');
});

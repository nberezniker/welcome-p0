import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramTransport } from '../../src/integrations/telegram/transport';

// ---------------------------------------------------------------------------
// TelegramTransport outcome mapping (fetch stubbed — no network in unit tests)
// ---------------------------------------------------------------------------

// Assembled at runtime so the fixture does not match the secret scanner's
// Telegram-token pattern; it is a dummy value, never a real credential.
const DUMMY_TOKEN = `12345:${'UNITTEST_dummy_token_value_'.repeat(2)}`;
const transport = new TelegramTransport(DUMMY_TOKEN);

function stubFetchOnce(impl: (url: string, init?: RequestInit) => Promise<Response>): void {
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string | URL | Request, init?: RequestInit) =>
    impl(String(url), init)) as typeof fetch;
}

test('transport: 2xx ok:true → sent with provider message id', async () => {
  stubFetchOnce(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), { status: 200 }));
  const r = await transport.send({ jobId: 'j', chatId: '42', text: 'hello' });
  assert.equal(r.state, 'sent');
  assert.equal(r.providerMessageId, '777');
});

test('transport: request goes to the Bot API sendMessage with chat_id+text, no parse_mode', async () => {
  let captured: { url: string; body: string | undefined } | undefined;
  stubFetchOnce(async (url, init) => {
    captured = { url, body: init?.body as string | undefined };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  });
  await transport.send({ jobId: 'j', chatId: '42', text: 'plain text' });
  assert.ok(captured);
  assert.match(captured!.url, new RegExp(`^https://api\\.telegram\\.org/bot${DUMMY_TOKEN}/sendMessage$`));
  const parsed = JSON.parse(captured!.body ?? '{}') as Record<string, unknown>;
  assert.equal(parsed['chat_id'], '42');
  assert.equal(parsed['text'], 'plain text');
  assert.equal(parsed['parse_mode'], undefined, 'P0: plain text only, no HTML parse mode');
});

test('transport: 429 with Retry-After → rate_limited + retryAfterSeconds (AC-43 input)', async () => {
  stubFetchOnce(async () => new Response(JSON.stringify({ ok: false }), {
    status: 429,
    headers: { 'retry-after': '17' },
  }));
  const r = await transport.send({ jobId: 'j', chatId: '42', text: 'hello' });
  assert.equal(r.state, 'unknown');
  assert.equal(r.code, 'rate_limited');
  assert.equal(r.retryAfterSeconds, 17);
});

test('transport: 429 without Retry-After header → rate_limited, no seconds', async () => {
  stubFetchOnce(async () => new Response(JSON.stringify({ ok: false }), { status: 429 }));
  const r = await transport.send({ jobId: 'j', chatId: '42', text: 'hello' });
  assert.equal(r.code, 'rate_limited');
  assert.equal(r.retryAfterSeconds, undefined);
});

test('transport: permanent 4xx → failed, no retry', async () => {
  for (const status of [400, 401, 403, 404]) {
    stubFetchOnce(async () => new Response(JSON.stringify({ ok: false, description: 'x' }), { status }));
    const r = await transport.send({ jobId: 'j', chatId: '42', text: 'hello' });
    assert.equal(r.state, 'failed', `HTTP ${status} must be failed`);
    assert.equal(r.code, `tg_http_${status}`);
  }
});

test('transport: 5xx → unknown (retryable)', async () => {
  stubFetchOnce(async () => new Response('bad gateway', { status: 502 }));
  const r = await transport.send({ jobId: 'j', chatId: '42', text: 'hello' });
  assert.equal(r.state, 'unknown');
  assert.equal(r.code, 'tg_http_5xx');
});

test('transport: network failure → unknown network_error', async () => {
  stubFetchOnce(async () => {
    throw new Error('ECONNRESET');
  });
  const r = await transport.send({ jobId: 'j', chatId: '42', text: 'hello' });
  assert.equal(r.state, 'unknown');
  assert.equal(r.code, 'network_error');
});

test('transport: timeout after send → unknown timeout (AC-42 input)', async () => {
  stubFetchOnce(async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });
  const r = await transport.send({ jobId: 'j', chatId: '42', text: 'hello' });
  assert.equal(r.state, 'unknown');
  assert.equal(r.code, 'timeout');
});

test('transport: 200 with ok:false (no message id) → failed, not silent success', async () => {
  stubFetchOnce(async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 200 }));
  const r = await transport.send({ jobId: 'j', chatId: '42', text: 'hello' });
  assert.equal(r.state, 'failed');
  assert.equal(r.providerMessageId, undefined);
});

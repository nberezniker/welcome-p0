import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectTransport, DisabledTransport } from '../../src/integrations/telegram';
import { MockTelegramTransport } from '../../src/integrations/telegram/mock-transport';
import { TelegramTransport } from '../../src/integrations/telegram/transport';

// ---------------------------------------------------------------------------
// selectTransport matrix — the mock gate (AC-05 family):
//   production + no token            → disabled (NEVER mock)
//   production + TELEGRAM_MOCK=1     → disabled (mock still forbidden)
//   dev/test + TELEGRAM_MOCK=1       → mock
//   TELEGRAM_BOT_TOKEN set           → real Bot API transport
// ---------------------------------------------------------------------------

const env = (overrides: Record<string, string>): Record<string, string | undefined> => ({
  APP_ENV: 'development',
  TELEGRAM_BOT_TOKEN: undefined,
  TELEGRAM_MOCK: undefined,
  ...overrides,
});

test('selectTransport: production without token → disabled (never mock)', async () => {
  const t = await selectTransport(env({ APP_ENV: 'production' }));
  assert.equal(t.name, 'telegram_disabled');
  assert.ok(t instanceof DisabledTransport);
});

test('selectTransport: production with TELEGRAM_MOCK=1 → STILL disabled (mock gate)', async () => {
  const t = await selectTransport(env({ APP_ENV: 'production', TELEGRAM_MOCK: '1' }));
  assert.equal(t.name, 'telegram_disabled');
  assert.ok(!(t instanceof MockTelegramTransport), 'mock must never be selected in production');
});

test('selectTransport: dev + TELEGRAM_MOCK=1 → mock', async () => {
  const t = await selectTransport(env({ APP_ENV: 'development', TELEGRAM_MOCK: '1' }));
  assert.equal(t.name, 'telegram_mock');
  assert.ok(t instanceof MockTelegramTransport);
});

test('selectTransport: TELEGRAM_BOT_TOKEN set → real transport regardless of mock flag', async () => {
  const t = await selectTransport(env({ TELEGRAM_BOT_TOKEN: '12345:AAAbbbCCC_dev_token' }));
  assert.equal(t.name, 'telegram_bot_api');
  assert.ok(t instanceof TelegramTransport);
});

test('selectTransport: dev without token and without mock → disabled, never silent drop', async () => {
  const t = await selectTransport(env({}));
  assert.equal(t.name, 'telegram_disabled');
  const result = await t.send({ jobId: 'j', chatId: '1', text: 'x' });
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'channel_disabled');
});

// ---------------------------------------------------------------------------
// Static gate: mock transport is NOT statically importable from src/ code.
// The only permitted references are the TEST-ONLY file itself, its unit tests,
// and the lazy dynamic import inside index.ts.
// ---------------------------------------------------------------------------

test('gate: mock transport is never statically imported outside tests', () => {
  const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        const content = readFileSync(full, 'utf8');
        if (/import[^'"]*(?:['"]).*mock-transport/.test(content) || content.includes("from './mock-transport'")) {
          // allow the lazy dynamic import in index.ts only
          if (full.endsWith('index.ts') && content.includes("import('./mock-transport')")) continue;
          offenders.push(path.relative(srcRoot, full));
        }
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, [], 'mock-transport must only be reachable behind the index.ts gate');
});

test('gate: index.ts contains the dev-only mock condition', () => {
  const indexPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'integrations', 'telegram', 'index.ts',
  );
  const content = readFileSync(indexPath, 'utf8');
  assert.ok(content.includes("TELEGRAM_MOCK === '1'"), 'mock selection requires TELEGRAM_MOCK=1');
  assert.ok(content.includes("!== 'production'"), 'mock selection requires non-production APP_ENV');
});

// ---------------------------------------------------------------------------
// Mock transport behaviour
// ---------------------------------------------------------------------------

test('mock transport: no script → every send succeeds with a stable message id', async () => {
  const mock = new MockTelegramTransport();
  const r1 = await mock.send({ jobId: 'j1', chatId: '42', text: 'hi' });
  const r2 = await mock.send({ jobId: 'j2', chatId: '42', text: 'yo' });
  assert.equal(r1.state, 'sent');
  assert.equal(r2.state, 'sent');
  assert.equal(r1.providerMessageId, 'mock-1');
  assert.equal(r2.providerMessageId, 'mock-2');
  assert.equal(mock.sent.length, 2);
});

test('mock transport: scripted outcomes are consumed FIFO', async () => {
  const mock = new MockTelegramTransport([
    { state: 'unknown', code: 'timeout' },
    { state: 'failed', code: 'tg_http_400' },
  ]);
  assert.equal((await mock.send({ jobId: 'j', chatId: '1', text: 'x' })).state, 'unknown');
  assert.equal((await mock.send({ jobId: 'j', chatId: '1', text: 'x' })).state, 'failed');
  assert.equal((await mock.send({ jobId: 'j', chatId: '1', text: 'x' })).state, 'sent'); // script exhausted
  assert.equal(mock.sendCount, 3);
});

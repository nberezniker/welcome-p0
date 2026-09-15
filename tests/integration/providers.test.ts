import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { GET as providers } from '../../src/app/api/providers/route';
import { assertStatus } from './helpers';
import { closeSql } from '../../src/lib/db';
import { PROVIDER_IDS } from '../../src/domain/providers';

/** GET /api/providers — public, session-free, env-aware and value-free. */

after(async () => {
  await closeSql();
});

interface ApiProvider {
  id: string;
  kind: string;
  auth: string;
  capabilities: string[];
  direction: string;
  status: string;
  reason_code: string | null;
  missing_env: string[];
  env: string[];
}

async function fetchProviders(): Promise<{ res: Response; list: ApiProvider[] }> {
  const res = await providers();
  assertStatus(res, 200);
  const body = (await res.json()) as { ok: boolean; providers: ApiProvider[] };
  assert.equal(body.ok, true);
  return { res, list: body.providers };
}

test('providers: anonymous GET returns every registry row in table order, no session needed', async () => {
  const { list } = await fetchProviders();
  assert.deepEqual(list.map((p) => p.id), [...PROVIDER_IDS]);
  // No cookie was sent — the endpoint must never require one.
  assert.equal(list.length > 0, true);
});

test('providers: payload is allowlisted — exactly the documented fields', async () => {
  const { list } = await fetchProviders();
  const allowed = new Set(['id', 'kind', 'auth', 'capabilities', 'direction', 'status', 'reason_code', 'missing_env', 'env']);
  for (const item of list) {
    for (const key of Object.keys(item)) assert.ok(allowed.has(key), `unexpected field: ${key}`);
    assert.ok(Array.isArray(item.capabilities) && item.capabilities.length > 0, `${item.id}: capabilities`);
    assert.ok(['live', 'disabled', 'planned'].includes(item.status), `${item.id}: status`);
    assert.ok(Array.isArray(item.env), `${item.id}: env must be a name list`);
  }
});

test('providers: the payload carries env NAMES and never their values', async () => {
  const sentinel = 'matrix-sentinel-telegram-token-value';
  const saved = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = sentinel;
  try {
    const { list } = await fetchProviders();
    const raw = JSON.stringify(list);
    assert.equal(raw.includes(sentinel), false, 'an env VALUE must never reach the payload');
    const telegram = list.find((p) => p.id === 'telegram')!;
    assert.deepEqual(telegram.env, ['TELEGRAM_BOT_TOKEN']);
    assert.equal(telegram.status, 'live');
    assert.equal(telegram.reason_code, null);
    assert.deepEqual(telegram.missing_env, []);
  } finally {
    if (saved === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = saved;
  }
});

test('providers: an instance without the telegram/email keys reports disabled + the missing name', async () => {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedResend = process.env.RESEND_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.RESEND_API_KEY;
  try {
    const { list } = await fetchProviders();
    const telegram = list.find((p) => p.id === 'telegram')!;
    assert.equal(telegram.status, 'disabled');
    assert.equal(telegram.reason_code, 'not_configured');
    assert.deepEqual(telegram.missing_env, ['TELEGRAM_BOT_TOKEN']);

    const email = list.find((p) => p.id === 'email')!;
    assert.equal(email.status, 'disabled');
    assert.equal(email.reason_code, 'not_configured');
    assert.deepEqual(email.missing_env, ['RESEND_API_KEY']);

    // Design states are untouched by the environment.
    assert.equal(list.find((p) => p.id === 'vcard')!.status, 'live');
    assert.equal(list.find((p) => p.id === 'ics')!.status, 'planned');
    assert.equal(list.find((p) => p.id === 'linkedin')!.status, 'disabled');
    assert.equal(list.find((p) => p.id === 'linkedin')!.reason_code, 'policy_restricted');
  } finally {
    if (savedToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedResend !== undefined) process.env.RESEND_API_KEY = savedResend;
  }
});

test('providers: documented shape of the two live channels and the disabled rows', async () => {
  const { list, res } = await fetchProviders();
  const byId = new Map(list.map((p) => [p.id, p]));

  assert.deepEqual(byId.get('telegram')!.capabilities, ['send', 'receive', 'deeplink']);
  assert.deepEqual(byId.get('email')!.capabilities, ['send']);
  assert.deepEqual(byId.get('vcard')!.capabilities, ['import', 'export']);
  assert.deepEqual(byId.get('ics')!.capabilities, ['export', 'deeplink']);
  assert.deepEqual(byId.get('ics')!.direction, 'out');

  // Cache discipline: env-dependent, so it must never be reused across instances.
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);

  const raw = JSON.stringify(list);
  // Setup step text lives in i18n keys, never in the public payload.
  assert.equal(raw.includes('providers.telegram.step1'), false);
});

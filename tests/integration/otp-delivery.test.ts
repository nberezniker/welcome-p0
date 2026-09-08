import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { POST as otpRequest } from '../../src/app/api/auth/otp/request/route';
import { makeRequest, uniqueEmail, assertStatus } from './helpers';
import { getSql, closeSql } from '../../src/lib/db';
import { emailLookupHash } from '../../src/lib/crypto';
import { requireHashPepper } from '../../src/lib/env';

// ---------------------------------------------------------------------------
// F-01 integration: the OTP request route honours the delivery matrix with the
// REAL route handler (DB + env flips). Env is restored in `finally` — the
// integration runner is sequential (--test-concurrency=1) so flips are safe.
// ---------------------------------------------------------------------------

after(async () => {
  await closeSql();
});

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function markDemo(email: string): Promise<void> {
  const hash = emailLookupHash(email, requireHashPepper());
  await getSql()`UPDATE accounts SET is_demo = true WHERE email_lookup_hash = ${hash}`;
}

test('otp request: dev + dev expose flag → devCode (pre-existing mechanism intact)', async () => {
  const email = uniqueEmail('f01-dev');
  await withEnv({ AUTH_DEV_EXPOSE_OTP: 'true', RESEND_API_KEY: undefined }, async () => {
    const res = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
    assertStatus(res, 200);
    const body = (await res.json()) as { ok: boolean; devCode?: string };
    assert.equal(body.ok, true);
    assert.match(body.devCode ?? '', /^\d{6}$/);
  });
});

test('otp request: dev without flags → {ok:true}, code lands in .runtime/otp.log (old dev behaviour kept)', async () => {
  const email = uniqueEmail('f01-log');
  await withEnv({ AUTH_DEV_EXPOSE_OTP: 'false', RESEND_API_KEY: undefined }, async () => {
    const res = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
    assertStatus(res, 200);
    const body = (await res.json()) as { ok: boolean; devCode?: string };
    assert.equal(body.ok, true);
    assert.equal(body.devCode, undefined);
    const log = await readFile(path.join(process.cwd(), '.runtime', 'otp.log'), 'utf8');
    const line = log.split('\n').find((l) => l.includes(email));
    assert.ok(line, 'otp.log must contain the code for the email');
    assert.match(line as string, /\t\d{6}$/);
  });
});

test('otp request: demo fallback — is_demo account + AUTH_EXPOSE_DEMO_OTP=true → devCode without any provider', async () => {
  const email = uniqueEmail('f01-demo');
  await withEnv({ AUTH_DEV_EXPOSE_OTP: 'false', AUTH_EXPOSE_DEMO_OTP: 'true', RESEND_API_KEY: undefined }, async () => {
    // First request creates the (non-demo) account; then we flag it is_demo.
    const first = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
    assertStatus(first, 200);
    const firstBody = (await first.json()) as { devCode?: string };
    assert.equal(firstBody.devCode, undefined, 'before the flag: regular account, no code');

    await markDemo(email);
    const second = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
    assertStatus(second, 200);
    const body = (await second.json()) as { ok: boolean; devCode?: string };
    assert.equal(body.ok, true);
    assert.match(body.devCode ?? '', /^\d{6}$/, 'demo account must receive the code in the response');
  });
});

test('otp request: AUTH_EXPOSE_DEMO_OTP=true + regular account → NO devCode', async () => {
  const email = uniqueEmail('f01-nodemo');
  await withEnv({ AUTH_DEV_EXPOSE_OTP: 'false', AUTH_EXPOSE_DEMO_OTP: 'true', RESEND_API_KEY: undefined }, async () => {
    const res = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
    assertStatus(res, 200);
    const body = (await res.json()) as { ok: boolean; devCode?: string };
    assert.equal(body.ok, true);
    assert.equal(body.devCode, undefined, 'the demo fallback must never apply to non-demo accounts');
  });
});

test('otp request: APP_ENV=production without provider → 503 email_channel_disabled (explicit, no devCode)', async () => {
  const email = uniqueEmail('f01-prod');
  await withEnv(
    {
      APP_ENV: 'production',
      AUTH_DEV_EXPOSE_OTP: 'false',
      AUTH_EXPOSE_DEMO_OTP: undefined,
      RESEND_API_KEY: undefined,
    },
    async () => {
      const res = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
      assert.equal(res.status, 503);
      const body = (await res.json()) as { code: string; retryable: boolean; devCode?: string };
      assert.equal(body.code, 'email_channel_disabled');
      assert.equal(body.retryable, false);
      assert.equal(body.devCode, undefined);
    },
  );
});

test('otp request: production + is_demo + demo flag → devCode (demo login works without provider)', async () => {
  const email = uniqueEmail('f01-prod-demo');
  await withEnv(
    {
      APP_ENV: 'development',
      AUTH_DEV_EXPOSE_OTP: 'false',
      AUTH_EXPOSE_DEMO_OTP: 'true',
      RESEND_API_KEY: undefined,
    },
    async () => {
      // Create + flag the demo account while still in development mode.
      await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
      await markDemo(email);

      process.env.APP_ENV = 'production';
      try {
        const res = await otpRequest(makeRequest('/api/auth/otp/request', { body: { email } }));
        assertStatus(res, 200);
        const body = (await res.json()) as { ok: boolean; devCode?: string };
        assert.equal(body.ok, true);
        assert.match(body.devCode ?? '', /^\d{6}$/);
      } finally {
        process.env.APP_ENV = 'development';
      }
    },
  );
});

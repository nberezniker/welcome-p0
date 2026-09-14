import test from 'node:test';
import assert from 'node:assert/strict';
import * as route from '../../src/app/api/auth/demo-login-info/route';

// ---------------------------------------------------------------------------
// Demo-login discovery endpoint. The login page asks it whether the
// AUTH_EXPOSE_DEMO_OTP fallback is live; the flag must be read per request
// (never baked into a build) and the response must never be cached.
// ---------------------------------------------------------------------------

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

test('demo-login-info: route is force-dynamic (the flag is never baked into the build)', () => {
  assert.equal(route.dynamic, 'force-dynamic');
});

test('demo-login-info: flag unset → disabled, no email disclosed', async () => {
  await withEnv({ AUTH_EXPOSE_DEMO_OTP: undefined }, async () => {
    const res = await route.GET();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { demoLoginEnabled: boolean; demoEmail: string | null };
    assert.deepEqual(body, { demoLoginEnabled: false, demoEmail: null });
  });
});

test('demo-login-info: flag="true" → enabled with the seeded demo address', async () => {
  await withEnv({ AUTH_EXPOSE_DEMO_OTP: 'true' }, async () => {
    const res = await route.GET();
    const body = (await res.json()) as { demoLoginEnabled: boolean; demoEmail: string | null };
    assert.equal(body.demoLoginEnabled, true);
    assert.equal(body.demoEmail, 'demo1@welcome.test');
  });
});

test('demo-login-info: any value other than exactly "true" → disabled', async () => {
  await withEnv({ AUTH_EXPOSE_DEMO_OTP: 'false' }, async () => {
    const body = (await (await route.GET()).json()) as { demoLoginEnabled: boolean; demoEmail: string | null };
    assert.deepEqual(body, { demoLoginEnabled: false, demoEmail: null });
  });
  await withEnv({ AUTH_EXPOSE_DEMO_OTP: '1' }, async () => {
    const body = (await (await route.GET()).json()) as { demoLoginEnabled: boolean; demoEmail: string | null };
    assert.deepEqual(body, { demoLoginEnabled: false, demoEmail: null });
  });
});

test('demo-login-info: response is explicitly uncacheable', async () => {
  await withEnv({ AUTH_EXPOSE_DEMO_OTP: 'true' }, async () => {
    const res = await route.GET();
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

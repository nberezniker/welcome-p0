import test from 'node:test';
import assert from 'node:assert/strict';
import { DisabledEmailTransport, DevOtpLogTransport, planOtpDelivery, selectEmailTransport, ResendEmailTransport, otpEmailTask } from '../../src/integrations/email';
import type { EmailTransport } from '../../src/integrations/email';

// ---------------------------------------------------------------------------
// F-01 CI gate: planOtpDelivery + selectEmailTransport matrix.
// The critical invariant: production WITHOUT an email provider must produce an
// EXPLICIT rejection (503 email_channel_disabled) — never a silent success,
// never the old unconditional dev-log write that 500s on a read-only FS.
// ---------------------------------------------------------------------------

const baseInput = {
  appEnv: 'production' as const,
  resendApiKey: undefined,
  devExposeOtp: false,
  exposeDemoOtp: false,
  isDemo: false,
};

test('plan: production + RESEND_API_KEY → real delivery', () => {
  const plan = planOtpDelivery({ ...baseInput, resendApiKey: 're_test_key' });
  assert.deepEqual(plan, { action: 'deliver' });
});

test('plan: production without key → EXPLICIT reject 503 email_channel_disabled (F-01 CI gate)', () => {
  const plan = planOtpDelivery(baseInput);
  // If this plan ever became a silent {ok:true} / dev-log write, login in
  // production would break exactly like F-01. The test fails loudly instead.
  assert.equal(plan.action, 'reject');
  assert.equal(plan.status, 503);
  assert.equal(plan.code, 'email_channel_disabled');
  assert.equal(plan.retryable, false);
});

test('plan: development without key → deliver (dev log transport)', () => {
  const plan = planOtpDelivery({ ...baseInput, appEnv: 'development' });
  assert.deepEqual(plan, { action: 'deliver' });
});

test('plan: test env without key → deliver (dev log transport)', () => {
  const plan = planOtpDelivery({ ...baseInput, appEnv: 'test' });
  assert.deepEqual(plan, { action: 'deliver' });
});

test('plan: AUTH_EXPOSE_DEMO_OTP on a NON-demo account does NOT expose the code', () => {
  const plan = planOtpDelivery({ ...baseInput, exposeDemoOtp: true, isDemo: false });
  assert.equal(plan.action, 'reject', 'the demo fallback must never leak codes for regular accounts');
});

test('plan: demo fallback (AUTH_EXPOSE_DEMO_OTP + is_demo) exposes the code even in production without a provider', () => {
  const plan = planOtpDelivery({ ...baseInput, exposeDemoOtp: true, isDemo: true });
  assert.deepEqual(plan, { action: 'expose' });
});

test('plan: demo fallback is OFF by default', () => {
  const plan = planOtpDelivery({ ...baseInput, isDemo: true });
  assert.equal(plan.action, 'reject');
});

test('plan: AUTH_DEV_EXPOSE_OTP is dev-only — ignored in production', () => {
  const plan = planOtpDelivery({ ...baseInput, devExposeOtp: true });
  assert.equal(plan.action, 'reject');
});

test('plan: AUTH_DEV_EXPOSE_OTP in development → expose (pre-existing test mechanism)', () => {
  const plan = planOtpDelivery({ ...baseInput, appEnv: 'development', devExposeOtp: true });
  assert.deepEqual(plan, { action: 'expose' });
});

// ---------------------------------------------------------------------------
// selectEmailTransport matrix
// ---------------------------------------------------------------------------

const env = (overrides: Record<string, string>): Record<string, string | undefined> => ({
  APP_ENV: 'development',
  RESEND_API_KEY: undefined,
  RESEND_FROM: undefined,
  ...overrides,
});

test('selectEmailTransport: production + key → real Resend transport', () => {
  const t = selectEmailTransport(env({ APP_ENV: 'production', RESEND_API_KEY: 're_live' }));
  assert.equal(t.name, 'resend');
  assert.ok(t instanceof ResendEmailTransport);
});

test('selectEmailTransport: development without key → dev otp.log transport', () => {
  const t = selectEmailTransport(env({}));
  assert.equal(t.name, 'dev_otp_log');
  assert.ok(t instanceof DevOtpLogTransport);
});

test('selectEmailTransport: production without key → disabled (never dev log)', () => {
  const t = selectEmailTransport(env({ APP_ENV: 'production' }));
  assert.equal(t.name, 'email_disabled');
  assert.ok(t instanceof DisabledEmailTransport);
});

test('selectEmailTransport: development with key → real transport (key wins)', () => {
  const t = selectEmailTransport(env({ RESEND_API_KEY: 're_dev' }));
  assert.equal(t.name, 'resend');
});

test('disabled transport fails honestly with channel_disabled', async () => {
  const t: EmailTransport = new DisabledEmailTransport();
  const result = await t.send(otpEmailTask('a@b.test', '123456'));
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'channel_disabled');
});

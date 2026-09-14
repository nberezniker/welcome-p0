import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OTP_EXPOSURE_WARNING,
  createOtpExposureWarner,
  otpExposureWarningMessage,
  warnIfOtpExposureOnProduction,
} from '../../src/lib/env';

// ---------------------------------------------------------------------------
// ADR 0009 — the operator tripwire. It must fire ONLY in production with the
// allowlist switch live, report the COUNT and never the addresses, and fire at
// most once per process (the OTP route runs on every login attempt).
// ---------------------------------------------------------------------------

test('warning: silent in development', () => {
  assert.equal(otpExposureWarningMessage('development', true, 3), null);
});

test('warning: silent in test', () => {
  assert.equal(otpExposureWarningMessage('test', true, 3), null);
});

test('warning: silent in production when the switch is off', () => {
  assert.equal(otpExposureWarningMessage('production', false, 3), null);
});

test('warning: fires in production with the switch on, exact text + count', () => {
  const message = otpExposureWarningMessage('production', true, 3);
  assert.ok(message);
  assert.ok(message.startsWith(OTP_EXPOSURE_WARNING), `unexpected text: ${message}`);
  assert.equal(message, `${OTP_EXPOSURE_WARNING} (3 allowlisted addresses)`);
});

test('warning: singular/plural is grammatical', () => {
  assert.equal(otpExposureWarningMessage('production', true, 1), `${OTP_EXPOSURE_WARNING} (1 allowlisted address)`);
  assert.equal(otpExposureWarningMessage('production', true, 0), `${OTP_EXPOSURE_WARNING} (0 allowlisted addresses)`);
});

test('warning: text matches the runbook string verbatim', () => {
  assert.equal(OTP_EXPOSURE_WARNING, 'DEV OTP EXPOSURE ENABLED ON PRODUCTION — staging-test only');
});

test('createOtpExposureWarner: logs at most once per instance', () => {
  const logged: string[] = [];
  const warn = createOtpExposureWarner((m) => logged.push(m));
  warn('production', true, 2);
  warn('production', true, 2);
  warn('production', true, 5);
  assert.equal(logged.length, 1);
  assert.match(logged[0] as string, /2 allowlisted addresses/);
  assert.match(logged[0] as string, /^\[otp-exposure\] /);
});

test('createOtpExposureWarner: a non-firing call does not consume the once-guard', () => {
  const logged: string[] = [];
  const warn = createOtpExposureWarner((m) => logged.push(m));
  warn('development', true, 2); // no-op
  warn('production', false, 2); // no-op
  warn('production', true, 2); // must still fire
  assert.equal(logged.length, 1);
});

test('createOtpExposureWarner: fresh instances are independent', () => {
  const first: string[] = [];
  const second: string[] = [];
  createOtpExposureWarner((m) => first.push(m))('production', true, 1);
  createOtpExposureWarner((m) => second.push(m))('production', true, 1);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
});

test('warnIfOtpExposureOnProduction: warns once per process and never prints addresses', () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    warnIfOtpExposureOnProduction('production', true, 2);
    warnIfOtpExposureOnProduction('production', true, 2);
    warnIfOtpExposureOnProduction('production', true, 7);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1, 'the route-level guard must warn exactly once per process');
  assert.match(warnings[0] as string, /2 allowlisted addresses/);
  // No address-shaped token anywhere in the output.
  assert.doesNotMatch(warnings[0] as string, /@/);
});

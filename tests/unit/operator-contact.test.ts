import test from 'node:test';
import assert from 'node:assert/strict';
import { operatorContactEmail, pilotMailto } from '../../src/lib/env';

/**
 * Operator contact — the address the landing page and the legal pages publish.
 *
 * The property under test is as much about ABSENCE as about presence: a clone
 * that never configures a contact must publish none. The upstream author's inbox
 * is not a default, and a pilot button that mails a stranger would be worse than
 * no button at all (SELF_HOSTING.md § Operator contact).
 */

const KEY = 'OPERATOR_CONTACT_EMAIL';

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
}

test('operator contact: unset publishes nothing and renders no pilot CTA', () => {
  withEnv(undefined, () => {
    assert.equal(operatorContactEmail(), '');
    assert.equal(pilotMailto(), null, 'null is what makes the page skip the CTA entirely');
  });
});

test('operator contact: blank and whitespace-only count as unset', () => {
  for (const blank of ['', '   ', '\t']) {
    withEnv(blank, () => {
      assert.equal(operatorContactEmail(), '');
      assert.equal(pilotMailto(), null);
    });
  }
});

test('operator contact: a configured address becomes the pilot mailto', () => {
  withEnv('  owner@example.test  ', () => {
    assert.equal(operatorContactEmail(), 'owner@example.test', 'surrounding whitespace is trimmed');
    assert.equal(pilotMailto(), 'mailto:owner@example.test?subject=WELCOME%20pilot');
  });
});

test('operator contact: there is no hardcoded fallback address anywhere', () => {
  // Guards the failure mode this whole mechanism exists for: someone "fixing"
  // the empty default by pasting a personal address back into the source.
  withEnv(undefined, () => {
    assert.equal(pilotMailto(), null, 'the default must be "no address", never somebody\'s inbox');
  });
});

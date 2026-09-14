import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideRecipientChannel, type ChannelFacts } from '../../src/infra/recipient-channel';

/**
 * Channel-selection truth table (ADR 0011). The rules encode two product
 * promises that must not drift:
 *   - an ACTIVE Telegram binding always wins — chat is the primary channel;
 *   - a REVOKED/BLOCKED binding is terminal: a "stop" is never silently
 *     re-routed to email;
 *   - consent only ever decides when a channel would otherwise be available, so
 *     a recipient with no channel and no address keeps `no_channel` (its
 *     historical, honest code) instead of being reported as a consent problem.
 */

function facts(over: Partial<ChannelFacts> = {}): ChannelFacts {
  return { telegramBinding: null, hasEmail: false, consentGranted: null, ...over };
}

test('channel: active telegram binding wins over an available email', () => {
  assert.deepEqual(decideRecipientChannel(facts({ telegramBinding: 'active', hasEmail: true })), { channel: 'telegram' });
  assert.deepEqual(
    decideRecipientChannel(facts({ telegramBinding: 'active', hasEmail: true, consentGranted: true })),
    { channel: 'telegram' },
  );
});

test('channel: active binding without consent is suppressed, never downgraded to email', () => {
  assert.deepEqual(
    decideRecipientChannel(facts({ telegramBinding: 'active', hasEmail: true, consentGranted: false })),
    { channel: 'suppress', code: 'consent_revoked' },
  );
});

test('channel: revoked/blocked bindings stay terminal even with an email on file', () => {
  assert.deepEqual(
    decideRecipientChannel(facts({ telegramBinding: 'revoked', hasEmail: true, consentGranted: true })),
    { channel: 'suppress', code: 'channel_revoked' },
  );
  assert.deepEqual(
    decideRecipientChannel(facts({ telegramBinding: 'blocked', hasEmail: true, consentGranted: true })),
    { channel: 'suppress', code: 'channel_blocked' },
  );
});

test('channel: no binding + email + consent → email', () => {
  assert.deepEqual(
    decideRecipientChannel(facts({ hasEmail: true, consentGranted: true })),
    { channel: 'email' },
  );
});

test('channel: no binding + email + no consent → consent_revoked', () => {
  assert.deepEqual(
    decideRecipientChannel(facts({ hasEmail: true, consentGranted: false })),
    { channel: 'suppress', code: 'consent_revoked' },
  );
});

test('channel: no binding + no email → no_channel regardless of consent', () => {
  assert.deepEqual(decideRecipientChannel(facts()), { channel: 'suppress', code: 'no_channel' });
  assert.deepEqual(
    decideRecipientChannel(facts({ consentGranted: true })),
    { channel: 'suppress', code: 'no_channel' },
  );
  assert.deepEqual(
    decideRecipientChannel(facts({ consentGranted: false })),
    { channel: 'suppress', code: 'no_channel' },
  );
});

test('channel: jobs that do not opt into consent still use email', () => {
  // consentGranted stays null → the consent precondition is not part of the decision.
  assert.deepEqual(decideRecipientChannel(facts({ hasEmail: true })), { channel: 'email' });
});

test('channel: a binding state that is neither active nor revoked/blocked is treated as absent', () => {
  // Defensive: the DB CHECK allows only the three states, so this is unreachable
  // today. If a future state is added it must never be read as "active" — an
  // unrecognized state degrades to the documented no-binding path.
  const decision = decideRecipientChannel({
    telegramBinding: 'unknown' as unknown as ChannelFacts['telegramBinding'],
    hasEmail: true,
    consentGranted: true,
  });
  assert.deepEqual(decision, { channel: 'email' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTelegramUpdate } from '../../src/integrations/telegram/updates';
import { secureSecretEqual } from '../../src/lib/crypto';

// ---------------------------------------------------------------------------
// Webhook update validation (hand-rolled, no new deps)
// ---------------------------------------------------------------------------

const VALID_UPDATE = {
  update_id: 1001,
  message: {
    message_id: 5,
    from: { id: 42, is_bot: false, first_name: 'A' },
    chat: { id: 42, type: 'private' },
    date: 1757241600,
    text: '/start link_abc',
  },
};

test('telegram update: valid message update parsed to minimal redacted payload', () => {
  const r = validateTelegramUpdate(VALID_UPDATE);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.updateId, 1001);
    assert.equal(r.value.eventType, 'message');
    assert.deepEqual(r.value.minimalPayload, {
      update_id: 1001,
      chat_id: 42,
      from_id: 42,
      text: '/start link_abc',
      message_id: 5,
    });
  }
});

test('telegram update: non-message update accepted with minimal payload (no processing)', () => {
  const r = validateTelegramUpdate({ update_id: 7, edited_message: { message_id: 1, chat: { id: 2 } } });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.eventType, 'non_message');
});

test('telegram update: message without from and text (channel post shape) is valid', () => {
  const r = validateTelegramUpdate({ update_id: 9, message: { message_id: 3, chat: { id: 5 } } });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.value.minimalPayload, { update_id: 9, chat_id: 5, message_id: 3 });
  }
});

const invalid: { label: string; body: unknown; code: string }[] = [
  { label: 'not an object', body: 'update', code: 'invalid_update' },
  { label: 'array body', body: [], code: 'invalid_update' },
  { label: 'missing update_id', body: { message: { message_id: 1, chat: { id: 1 } } }, code: 'invalid_update_id' },
  { label: 'float update_id', body: { update_id: 1.5 }, code: 'invalid_update_id' },
  { label: 'negative update_id', body: { update_id: -1 }, code: 'invalid_update_id' },
  { label: 'message not object', body: { update_id: 1, message: 'x' }, code: 'invalid_message' },
  { label: 'missing message_id', body: { update_id: 1, message: { chat: { id: 2 } } }, code: 'invalid_message_id' },
  { label: 'chat missing', body: { update_id: 1, message: { message_id: 1 } }, code: 'invalid_chat' },
  { label: 'chat id float', body: { update_id: 1, message: { message_id: 1, chat: { id: 2.5 } } }, code: 'invalid_chat' },
  { label: 'from id junk', body: { update_id: 1, message: { message_id: 1, chat: { id: 2 }, from: { id: 'x' } } }, code: 'invalid_from' },
  { label: 'text not string', body: { update_id: 1, message: { message_id: 1, chat: { id: 2 }, text: 9 } }, code: 'invalid_text' },
  {
    label: 'text too long',
    body: { update_id: 1, message: { message_id: 1, chat: { id: 2 }, text: 'a'.repeat(4097) } },
    code: 'invalid_text',
  },
];

test('telegram update: invalid bodies fail closed with specific codes', () => {
  for (const c of invalid) {
    const r = validateTelegramUpdate(c.body);
    assert.equal(r.ok, false, `expected failure for: ${c.label}`);
    if (!r.ok) assert.equal(r.code, c.code, `wrong code for: ${c.label}`);
  }
});

// ---------------------------------------------------------------------------
// Webhook secret — constant-time compare
// ---------------------------------------------------------------------------

test('secureSecretEqual: equal secrets match', () => {
  assert.equal(secureSecretEqual('s3cret-webhook-token', 's3cret-webhook-token'), true);
});

test('secureSecretEqual: different values and lengths never match, never throw', () => {
  assert.equal(secureSecretEqual('s3cret-webhook-token', 's3cret-webhook-tOken'), false);
  assert.equal(secureSecretEqual('short', 'a-much-longer-secret-value'), false);
  assert.equal(secureSecretEqual('', ''), true); // both empty is a match; route rejects missing env separately
});

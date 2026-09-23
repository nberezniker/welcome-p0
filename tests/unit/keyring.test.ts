import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_KEY_ID,
  decryptStored,
  decryptValue,
  encryptStored,
  encryptValue,
  parseKeyring,
  payloadKeyId,
  type Keyring,
} from '../../src/lib/crypto';

/**
 * THE KEYRING — and the compatibility claim, pinned rather than asserted.
 *
 * The claim this file exists to prove: a deployment that sets ONLY
 * `ENCRYPTION_KEY` (every deployment that exists today, every `.env.example`,
 * every test fixture) gets a one-key keyring whose active id is `v1`, and the
 * values it writes are the values it wrote before the keyring existed.
 *
 * WHAT CAN AND CANNOT BE PINNED, stated plainly rather than papered over:
 *
 *   · BYTE-IDENTITY OF A WHOLE PAYLOAD IS NOT PINNABLE, and the reason is the
 *     design, not the test: every payload carries a fresh RANDOM 12-byte IV
 *     (`randomBytes(12)`), so two encryptions of the same value under the same
 *     key are deliberately different strings — the pre-existing suite asserts
 *     exactly that ("random IV — two encryptions of the same value differ"), and
 *     any test asserting one exact output would be asserting that randomness
 *     away. So what is pinned is everything the IV does not touch: the FORMAT,
 *     the ID, the segment lengths, the round-trip, and the CROSS-PATH readability
 *     of payloads written before this change by code that no longer runs.
 *
 *   · "PRODUCED BEFORE THIS CHANGE" IS PINNED WITH A LITERAL. PRE_CHANGE_PAYLOAD
 *     below was produced by the previous `encryptValue` (a single hard-coded
 *     `v1` prefix, one env key) before this change landed, under
 *     PRE_CHANGE_KEY — a deliberately low-entropy test key, never a real one.
 *     It is a fixture, not a generated value, which is the only way to assert
 *     "a payload that already exists in a real database still decodes".
 */

// 32-byte test keys. Low entropy on purpose (Buffer.alloc) — never a deployment.
const KEY = Buffer.alloc(32, 11).toString('base64');
const KEY_B = Buffer.alloc(32, 12).toString('base64');
const KEY_C = Buffer.alloc(32, 13).toString('base64');

/** Ciphertext produced by the PRE-KEYRING implementation, before this change. */
const PRE_CHANGE_KEY = KEY;
const PRE_CHANGE_PAYLOAD = 'v1.bGLuOPQ093/grfJh.3EYCN3xoxLes5gbCClUcLW39J+NzmdC98qFzWZfCpn9KxMGo.Ds+IISoxS1aFTAItVyumpQ==';
const PRE_CHANGE_PLAINTEXT = 'pre-change payload: +7 900 000-00-00';

function keyringOf(input: Parameters<typeof parseKeyring>[0]): Keyring {
  const parsed = parseKeyring(input);
  assert.equal(parsed.ok, true, `expected a keyring, got: ${parsed.ok ? '' : parsed.message}`);
  return (parsed as { ok: true; keyring: Keyring }).keyring;
}

// ---------------------------------------------------------------------------
// The single-key shorthand: today's behaviour, unchanged
// ---------------------------------------------------------------------------

test('keyring: ENCRYPTION_KEY alone is a one-key keyring, active id v1', () => {
  const keyring = keyringOf({ encryptionKey: KEY });
  assert.equal(keyring.active, LEGACY_KEY_ID);
  assert.equal(keyring.active, 'v1');
  assert.deepEqual([...keyring.keys.keys()], ['v1'], 'exactly one id, and it is the legacy one');
  assert.equal(keyring.keys.get('v1'), KEY);
});

test('keyring: a payload written with the keyring names v1 and has todays exact format', () => {
  // The claim "the emitted format is exactly <keyid>.<iv>.<ct>.<tag> with the id
  // being v1" — every part of it that is not the random IV.
  const payload = encryptStored('+7 900 000-00-00', keyringOf({ encryptionKey: KEY }));
  const parts = payload.split('.');
  assert.equal(parts.length, 4, 'four segments, as before');
  assert.equal(parts[0], 'v1', 'the key id slot holds v1, which is what it held as a "version"');
  assert.equal(Buffer.from(parts[1] as string, 'base64').length, 12, '12-byte IV');
  assert.equal(Buffer.from(parts[3] as string, 'base64').length, 16, '16-byte GCM tag');
  for (const segment of parts.slice(1)) {
    assert.match(segment as string, /^[A-Za-z0-9+/]+={0,2}$/, 'standard base64, no padding tricks');
  }
  // The old reader is untouched, so a payload written by the NEW writer is a
  // payload the OLD code path can read: that is the "unchanged in production" claim.
  assert.equal(decryptValue(payload, KEY), '+7 900 000-00-00');
});

test('keyring: the two writers are interchangeable in both directions', () => {
  const keyring = keyringOf({ encryptionKey: KEY });
  const viaKeyring = encryptStored('interchangeable', keyring);
  const viaLegacy = encryptValue('interchangeable', KEY);

  // Same id, same shape — the only difference between them is the random IV.
  assert.equal(payloadKeyId(viaKeyring), payloadKeyId(viaLegacy));
  assert.equal(viaKeyring.split('.')[0], viaLegacy.split('.')[0]);

  // And each one's output is readable by the other reader.
  assert.equal(decryptValue(viaKeyring, KEY), 'interchangeable');
  assert.equal(decryptStored(viaLegacy, keyring), 'interchangeable');
});

test('keyring: a payload produced BEFORE the keyring existed still decodes (read-both)', () => {
  // The assessment's requirement: rows already in a database stay readable.
  const keyring = keyringOf({ encryptionKey: PRE_CHANGE_KEY });

  assert.equal(decryptValue(PRE_CHANGE_PAYLOAD, PRE_CHANGE_KEY), PRE_CHANGE_PLAINTEXT, 'legacy path, unchanged');
  assert.equal(decryptStored(PRE_CHANGE_PAYLOAD, keyring), PRE_CHANGE_PLAINTEXT, 'keyring path, same bytes');
  assert.equal(payloadKeyId(PRE_CHANGE_PAYLOAD), 'v1');

  // It is a REAL pre-change payload, not a v1-shaped string: the same plaintext
  // sealed with a DIFFERENT key must not open it.
  const other = keyringOf({ encryptionKey: KEY_B });
  assert.throws(() => decryptStored(PRE_CHANGE_PAYLOAD, other));
});

test('keyring: the legacy reader still refuses any id that is not v1', () => {
  // Pinned because it is the behaviour that made rotation impossible: a payload
  // under another id was rejected as MALFORMED, before any key was consulted.
  assert.throws(() => decryptValue('v2.a.b.c', KEY), { message: 'encrypted value format is invalid' });
  assert.throws(() => decryptValue('garbage', KEY), { message: 'encrypted value format is invalid' });
  assert.throws(() => decryptValue('v1.aaaa', KEY), { message: 'encrypted value format is invalid' });
});

// ---------------------------------------------------------------------------
// Reading more than one key
// ---------------------------------------------------------------------------

test('keyring: writes name the ACTIVE id; all ids stay readable', () => {
  const keyring = keyringOf({ encryptionKey: KEY_B, activeKeyId: 'v2', encryptionKeys: `v1:${KEY}` });
  assert.equal(keyring.active, 'v2');
  assert.deepEqual([...keyring.keys.keys()].sort(), ['v1', 'v2']);

  const payload = encryptStored('rotating', keyring);
  assert.equal(payloadKeyId(payload), 'v2', 'new writes carry the new id');
  assert.equal(decryptStored(payload, keyring), 'rotating');

  // A row sealed before the flip, still readable: this is what makes step 2 of a
  // rotation (flip the active id) safe to do while old rows remain.
  const old = encryptValue('written before the flip', KEY);
  assert.equal(payloadKeyId(old), 'v1');
  assert.equal(decryptStored(old, keyring), 'written before the flip');
});

test('keyring: an id the keyring does not have is a hard error NAMING it, never a fallback', () => {
  // The failure mode this refuses to have: silently decrypting with the active
  // key and returning garbage, or a 500 that does not say which key is missing.
  const keyring = keyringOf({ encryptionKey: KEY });
  const foreign = `v7.${PRE_CHANGE_PAYLOAD.split('.').slice(1).join('.')}`;
  assert.throws(() => decryptStored(foreign, keyring), { message: /no encryption key with id v7/ });
});

test('keyring: an unconfigured keyring refuses too', () => {
  const empty = { active: 'v1', keys: new Map<string, string>() } as Keyring;
  assert.throws(() => encryptStored('x', empty), { message: /no encryption key with id v1/ });
});

test('payloadKeyId: reads the slot, or reports that there is no payload', () => {
  assert.equal(payloadKeyId('v1.a.b.c'), 'v1');
  assert.equal(payloadKeyId('v12.a.b.c'), 'v12');
  assert.equal(payloadKeyId('garbage'), null);
  assert.equal(payloadKeyId('v1.a.b'), null, 'three segments is not a payload');
  assert.equal(payloadKeyId('v1..b.c'), null, 'an empty segment is not a payload');
  assert.equal(payloadKeyId('.a.b.c'), null);
});

// ---------------------------------------------------------------------------
// Every misconfiguration is a refusal that names the problem
// ---------------------------------------------------------------------------

test('keyring: a missing ENCRYPTION_KEY is refused, by the name the operator greps for', () => {
  for (const encryptionKey of [undefined, '', '   ']) {
    const parsed = parseKeyring({ encryptionKey });
    assert.equal(parsed.ok, false);
    assert.match((parsed as { ok: false; message: string }).message, /ENCRYPTION_KEY is not configured/);
  }
});

test('keyring: the active key id appears in ENCRYPTION_KEYS — refused, not resolved', () => {
  // Accepting this would mean two different keys behind one id, so which key a
  // payload needs would be ambiguous: exactly the state that makes data silently
  // unreadable. The active key's material is ENCRYPTION_KEY; naming it again is
  // an error, not a second opinion.
  const parsed = parseKeyring({ encryptionKey: KEY, activeKeyId: 'v2', encryptionKeys: `v2:${KEY_C}` });
  assert.equal(parsed.ok, false);
  assert.match((parsed as { ok: false; message: string }).message, /names the active key id v2/);
});

test('keyring: a duplicate id, a bad id and a wrong-length key are each refused', () => {
  const duplicate = parseKeyring({ encryptionKey: KEY, encryptionKeys: `v2:${KEY_B},v2:${KEY_C}` });
  assert.equal(duplicate.ok, false);
  assert.match((duplicate as { ok: false; message: string }).message, /names the id v2 twice/);

  const badId = parseKeyring({ encryptionKey: KEY, encryptionKeys: `V 2:${KEY_B}` });
  assert.equal(badId.ok, false);
  assert.match((badId as { ok: false; message: string }).message, /unusable key id/);

  const shortKey = parseKeyring({ encryptionKey: KEY, encryptionKeys: `v2:${Buffer.alloc(16, 1).toString('base64')}` });
  assert.equal(shortKey.ok, false);
  assert.match((shortKey as { ok: false; message: string }).message, /must decode to exactly 32 bytes/);

  const noColon = parseKeyring({ encryptionKey: KEY, encryptionKeys: 'v2' });
  assert.equal(noColon.ok, false);
  assert.match((noColon as { ok: false; message: string }).message, /is not <id>:<base64>/);

  const badActive = parseKeyring({ encryptionKey: KEY, activeKeyId: 'v.2' });
  assert.equal(badActive.ok, false);
  assert.match((badActive as { ok: false; message: string }).message, /ENCRYPTION_KEY_ID is not a usable key id/);
});

test('keyring: a refusing message never echoes key material', () => {
  // These strings end up in a terminal and in CI logs. A refusal that printed the
  // mistyped key would turn a configuration error into a secret leak.
  const wrongLength = Buffer.alloc(16, 9).toString('base64');
  const refused = [
    parseKeyring({ encryptionKey: KEY, activeKeyId: 'v2', encryptionKeys: `v2:${KEY_C}` }),
    parseKeyring({ encryptionKey: KEY, encryptionKeys: `v2:${KEY_B},v2:${KEY_C}` }),
    parseKeyring({ encryptionKey: KEY, encryptionKeys: `v2:${wrongLength}` }),
    parseKeyring({ encryptionKey: KEY, encryptionKeys: 'v2' }),
  ];
  for (const parsed of refused) {
    assert.equal(parsed.ok, false);
    const message = (parsed as { ok: false; message: string }).message;
    for (const material of [KEY, KEY_B, KEY_C, wrongLength]) {
      assert.ok(!message.includes(material), `message leaked key material: ${message}`);
    }
  }
});

test('keyring: whitespace, an empty keyring and a trailing comma are the forgiving cases', () => {
  const forgiving = keyringOf({ encryptionKey: `  ${KEY}  `, encryptionKeys: ` v1x:${KEY_B} , ` });
  assert.deepEqual([...forgiving.keys.keys()].sort(), ['v1', 'v1x']);

  // An empty ENCRYPTION_KEYS is the normal state, not a half-configured keyring.
  assert.deepEqual([...keyringOf({ encryptionKey: KEY, encryptionKeys: '' }).keys.keys()], ['v1']);
  assert.deepEqual([...keyringOf({ encryptionKey: KEY, encryptionKeys: '   ' }).keys.keys()], ['v1']);

  // And a blank ENCRYPTION_KEY_ID means the default, not an id of "".
  assert.equal(keyringOf({ encryptionKey: KEY, activeKeyId: '  ' }).active, 'v1');
});

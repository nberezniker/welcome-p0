import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptStored, encryptStored, encryptValue, parseKeyring, type Keyring } from '../../src/lib/crypto';
import {
  CENSUS_LEGEND,
  ENCRYPTED_COLUMNS,
  ROTATE_BATCH_DEFAULT,
  ROTATE_LIMIT_DEFAULT,
  addBatch,
  classifyPayload,
  classifyStoredValue,
  columnLabel,
  emptyCensus,
  formatCensusRow,
  formatColumnDetail,
  formatKeyIdCensus,
  parseRotateArgs,
  readStoredValue,
  reencryptStoredValue,
  verdictFor,
} from '../../src/domain/key-rotation';

/**
 * THE ROTATION COMMAND'S DECISIONS, as pure functions.
 *
 * What this file is for: the command is allowed to rewrite ciphertext in five
 * tables, so its two safety properties have to be provable without a database —
 *
 *   1. EVERY row lands in exactly one class, and the classes add up to the row
 *      count. A command that reports "412 rows, 7 rewritten" tells the operator
 *      nothing about the other 405;
 *   2. THE ROWS IT WILL NOT TOUCH ARE NAMED, with primary keys, because "3
 *      unreadable" is not actionable on its own — an operator has to be able to
 *      answer "which three" without writing SQL. Values are never printed, and
 *      these tests assert that too.
 *
 * It also pins the interface (flags and their refusals), because a typo in
 * `--dry-run` must not become a real write — the same stance `pnpm demo:reset`
 * takes, and the same shared acknowledgement flag.
 */

const KEY_A = Buffer.alloc(32, 21).toString('base64');
const KEY_B = Buffer.alloc(32, 22).toString('base64');
const SECRET = 'a-contact-value-that-must-never-be-printed';

function keyringOf(input: Parameters<typeof parseKeyring>[0]): Keyring {
  const parsed = parseKeyring(input);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.keyring;
}

/** A keyring mid-rotation: v1 is the retired key, v2 the active one. */
const ROTATING = keyringOf({ encryptionKey: KEY_B, activeKeyId: 'v2', encryptionKeys: `v1:${KEY_A}` });

/** The same payload with a different id in its first slot — how a foreign or
 *  wrong-key row looks on disk, without hand-writing base64. */
function relabelled(payload: string, id: string): string {
  return `${id}.${payload.split('.').slice(1).join('.')}`;
}

const STALE_PAYLOAD = encryptValue(SECRET, KEY_A); // written before the flip: id v1
const CURRENT_PAYLOAD = encryptStored(SECRET, ROTATING); // written after it: id v2

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('classify: the four payload classes, and NULL as its own', () => {
  assert.equal(classifyPayload(CURRENT_PAYLOAD, ROTATING), 'current', 'names the active id');
  assert.equal(classifyPayload(STALE_PAYLOAD, ROTATING), 'stale', 'a key we still hold, and it decrypts');
  assert.equal(classifyPayload(relabelled(STALE_PAYLOAD, 'v9'), ROTATING), 'foreign', 'no key with that id');
  assert.equal(classifyPayload('not-a-payload', ROTATING), 'corrupt');
  assert.equal(classifyPayload('v1.a.b', ROTATING), 'corrupt', 'three segments is not a payload');
  assert.equal(classifyStoredValue(null, ROTATING), 'null');
});

test('classify: a row whose id is known but whose key is WRONG is corrupt, not stale', () => {
  // The distinction that keeps the apply pass predictable: STALE means "proven
  // re-encryptable in memory", so a row whose key material does not match the id
  // it names is reported as unreadable instead of being attempted and failing
  // halfway through a write pass.
  const wrongKey = relabelled(encryptValue(SECRET, KEY_B), 'v1'); // says v1, sealed with v2's key
  assert.equal(classifyPayload(wrongKey, ROTATING), 'corrupt');
  const attempt = reencryptStoredValue(wrongKey, ROTATING);
  assert.equal(attempt.ok, false);
  assert.ok(
    'reason' in attempt && !attempt.reason.includes(SECRET),
    'the failure reason names a key, never the value',
  );
});

test('classify: the ACTIVE id is read too — a repointed id is reported, not called healthy', () => {
  // The mistake this catches: changing ENCRYPTION_KEY without changing
  // ENCRYPTION_KEY_ID, i.e. keeping the id while swapping the material behind it.
  // Classifying by id alone would report every affected row as `current` —
  // healthy — while nothing in the deployment could read it.
  const repointed = relabelled(encryptValue(SECRET, KEY_A), 'v2'); // active id, someone else's key
  assert.equal(classifyPayload(repointed, ROTATING), 'corrupt');
  assert.equal(readStoredValue(repointed, ROTATING).ok, false);
  // And the honest case still classifies as current, because it was actually opened.
  assert.equal(readStoredValue(CURRENT_PAYLOAD, ROTATING).ok, true);
  assert.equal(classifyPayload(CURRENT_PAYLOAD, ROTATING), 'current');
});

test('classify: a foreign payload reports which id is missing, and is never rewritten', () => {
  const foreign = relabelled(STALE_PAYLOAD, 'v9');
  const attempt = reencryptStoredValue(foreign, ROTATING);
  assert.equal(attempt.ok, false);
  assert.match((attempt as { ok: false; reason: string }).reason, /id v9/);
});

test('reencrypt: the rewritten payload keeps the value and names the active key', () => {
  const rewritten = reencryptStoredValue(STALE_PAYLOAD, ROTATING);
  assert.equal(rewritten.ok, true);
  const payload = (rewritten as { ok: true; payload: string }).payload;
  assert.equal(payload.split('.')[0], 'v2');
  assert.equal(decryptStored(payload, ROTATING), SECRET);
  assert.notEqual(payload, STALE_PAYLOAD, 'a fresh IV, so the ciphertext differs');
});

// ---------------------------------------------------------------------------
// The census
// ---------------------------------------------------------------------------

const ROWS = [
  { pk: 'pk-1', payload: CURRENT_PAYLOAD },
  { pk: 'pk-2', payload: STALE_PAYLOAD },
  { pk: 'pk-3', payload: STALE_PAYLOAD },
  { pk: 'pk-4', payload: relabelled(STALE_PAYLOAD, 'v9') }, // foreign
  { pk: 'pk-5', payload: 'not-a-payload' }, // corrupt
  { pk: 'pk-6', payload: null }, // the NULL of a nullable column
];

test('census: every row lands in exactly one class and the classes add up', () => {
  const census = addBatch(emptyCensus(), ROWS, ROTATING, 20);
  assert.equal(census.scanned, ROWS.length);
  assert.deepEqual(census.counts, { current: 1, stale: 2, foreign: 1, corrupt: 1, null: 1 });
  const summed = Object.values(census.counts).reduce((a, b) => a + b, 0);
  assert.equal(summed, census.scanned, 'the counts account for EVERY row, which is the point of the census');
});

test('census: primary keys are kept per class, and the id each row names is kept with them', () => {
  const census = addBatch(emptyCensus(), ROWS, ROTATING, 20);
  assert.deepEqual(census.rowRefs.stale.map((r) => r.pk), ['pk-2', 'pk-3']);
  assert.deepEqual(census.rowRefs.stale.map((r) => r.keyId), ['v1', 'v1']);
  assert.deepEqual(census.rowRefs.foreign, [{ pk: 'pk-4', keyId: 'v9' }]);
  assert.deepEqual(census.rowRefs.corrupt.map((r) => r.pk), ['pk-5']);
  assert.equal(census.counts.null, 1, 'a NULL has no identity and no class to be listed under');
  assert.deepEqual(census.rowRefs.current.map((r) => r.pk), ['pk-1']);
});

test('census: the identity list is capped, the COUNT is not', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ pk: `pk-${String(i).padStart(2, '0')}`, payload: STALE_PAYLOAD }));
  const capped = addBatch(emptyCensus(), many, ROTATING, 5);
  assert.equal(capped.counts.stale, 45, 'the count stays exact — it is what the report is built on');
  assert.equal(capped.rowRefs.stale.length, 5, 'only the first 5 keys are carried');

  const all = addBatch(emptyCensus(), many, ROTATING, 0);
  assert.equal(all.rowRefs.stale.length, 45, 'limit 0 means "list every one of them"');
});

test('census: batching across pages is the same census as one pass', () => {
  const onePass = addBatch(emptyCensus(), ROWS, ROTATING, 20);
  let paged = emptyCensus();
  for (const row of ROWS) paged = addBatch(paged, [row], ROTATING, 20);
  assert.deepEqual(paged.counts, onePass.counts);
  assert.deepEqual(paged.scanned, onePass.scanned);
  assert.deepEqual(
    paged.rowRefs.stale.map((r) => r.pk),
    onePass.rowRefs.stale.map((r) => r.pk),
  );
});

test('census: payloads are also counted by key id — the number a retirement depends on', () => {
  const census = addBatch(emptyCensus(), ROWS, ROTATING, 20);
  // A FOREIGN id is counted too: those rows do name an id, and a retirement check
  // that reads "0" for an id rows actually mention would be a lie.
  assert.deepEqual(census.byKeyId, { v1: 2, v2: 1, v9: 1 });

  // The invariant that makes the numbers trustworthy: every scanned row is either
  // counted under an id it names, is a NULL, or is not a payload at all.
  const accounted =
    Object.values(census.byKeyId).reduce((a, b) => a + b, 0) + census.counts.null + census.counts.corrupt;
  assert.equal(accounted, census.scanned);
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test('report: the per-class table carries the counts, and the legend says what unreadable means', () => {
  const entry = ENCRYPTED_COLUMNS[0]!;
  const census = addBatch(emptyCensus(), ROWS, ROTATING, 20);
  const row = formatCensusRow(entry, census);
  for (const value of ['1', '2']) assert.ok(row.includes(value));
  assert.match(row, /contact_fields\.encrypted_value/);
  assert.match(CENSUS_LEGEND, /foreign/);
  assert.match(CENSUS_LEGEND, /corrupt/);
});

test('report: every class that needs a human is listed with primary keys — never a value', () => {
  const entry = ENCRYPTED_COLUMNS[0]!;
  const census = addBatch(emptyCensus(), ROWS, ROTATING, 20);
  const lines = formatColumnDetail(entry, census).join('\n');

  // Actionability: the operator can name the rows without writing SQL.
  for (const pk of ['pk-2', 'pk-3', 'pk-4', 'pk-5']) assert.ok(lines.includes(pk), `missing ${pk}`);
  // ...and knows which id an unreadable row wants back.
  assert.ok(lines.includes('key id v9'), 'the missing id must be visible on the row itself');
  // The `current` bulk is not listed: there is nothing to find there.
  assert.ok(!lines.includes('pk-1'));
  // And nothing sensitive: no ciphertext, no plaintext.
  assert.ok(!lines.includes(STALE_PAYLOAD) && !lines.includes(SECRET) && !lines.includes(KEY_A));
});

test('report: a truncated listing says how many are left and how to see them', () => {
  const entry = ENCRYPTED_COLUMNS[0]!;
  const many = Array.from({ length: 7 }, (_, i) => ({ pk: `pk-${i}`, payload: STALE_PAYLOAD }));
  const lines = formatColumnDetail(entry, addBatch(emptyCensus(), many, ROTATING, 3)).join('\n');
  assert.match(lines, /and 4 more — list them all with --limit=0/);
});

test('report: a column with nothing to act on prints nothing at all', () => {
  const entry = ENCRYPTED_COLUMNS[0]!;
  const clean = addBatch(emptyCensus(), [{ pk: 'pk-1', payload: CURRENT_PAYLOAD }], ROTATING, 20);
  assert.deepEqual(formatColumnDetail(entry, clean), []);
});

test('report: the key-id census is the pre-retirement check, per column', () => {
  const lines = formatKeyIdCensus([
    { entry: ENCRYPTED_COLUMNS[0]!, census: addBatch(emptyCensus(), ROWS, ROTATING, 20) },
  ]).join('\n');
  assert.match(lines, /rows by key id/);
  assert.match(lines, /v1 2/);
  assert.match(lines, /v2 1/);
  assert.match(lines, /v9 1/, 'a foreign id is listed, so a retirement check cannot read a false zero');
  assert.match(lines, /null 1/);
  assert.match(lines, /not a payload 1/);
});

test('verdict: complete means no stale rows; unreadable is counted, not silently folded in', () => {
  const withStale = verdictFor([addBatch(emptyCensus(), ROWS, ROTATING, 20)]);
  assert.equal(withStale.complete, false);
  assert.equal(withStale.stale, 2);
  assert.equal(withStale.unreadable, 2, 'foreign + corrupt');

  const clean = verdictFor([addBatch(emptyCensus(), [ROWS[0]!], ROTATING, 20)]);
  assert.equal(clean.complete, true);
  assert.equal(clean.stale, 0);

  // Unreadable rows do NOT block completion: retiring a key cannot make an
  // already-unreadable row worse, and blocking would leave the operator stuck.
  const unreadableOnly = verdictFor([addBatch(emptyCensus(), [ROWS[3]!, ROWS[4]!], ROTATING, 20)]);
  assert.equal(unreadableOnly.complete, true);
  assert.equal(unreadableOnly.unreadable, 2);
});

test('verdict: a retired id that rows still NAME is reported, so the report cannot print a false zero', () => {
  // The case this exists for: a row names v1 but cannot be read under it. It is not
  // stale (there is nothing to rewrite) so the rotation is "complete", but v1 must
  // NOT be reported as reading zero — the row still mentions it.
  const withStale = addBatch(emptyCensus(), ROWS, ROTATING, 20);
  assert.deepEqual(verdictFor([withStale], ['v1', 'v7']).stillNamed, [
    { id: 'v1', rows: 2 }, // the two stale rows; v7 is named by nothing, so it is absent
  ]);

  // A corrupt row with NO parseable id belongs to no id at all — it is reported by
  // the class table and the `not a payload` note, never as a row under some id.
  assert.equal(withStale.byKeyId['not-a-payload'], undefined);
  const unreadableOnly = addBatch(emptyCensus(), [ROWS[3]!, ROWS[4]!], ROTATING, 20);
  assert.deepEqual(verdictFor([unreadableOnly], ['v9']).stillNamed, [{ id: 'v9', rows: 1 }]);

  // And with no retired ids asked about, there is nothing to report.
  assert.deepEqual(verdictFor([withStale]).stillNamed, []);
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test('registry: six columns, each identified uniquely, each naming a primary key', () => {
  assert.equal(ENCRYPTED_COLUMNS.length, 6);
  const labels = ENCRYPTED_COLUMNS.map(columnLabel);
  assert.equal(new Set(labels).size, labels.length, 'two entries for one column would double-count it');
  for (const entry of ENCRYPTED_COLUMNS) {
    assert.ok(entry.table.length > 0 && entry.column.length > 0 && entry.pk.length > 0);
    assert.ok(entry.holds.length > 0, 'the report explains what the ciphertext holds');
    assert.ok(!entry.pk.includes('.') && !entry.table.includes('.'), 'identifiers are used unquoted in SQL');
  }
  // oauth_grants appears twice (access + refresh token): two columns, one table.
  assert.equal(new Set(ENCRYPTED_COLUMNS.map((c) => c.table)).size, 5);
  // The schema is the arbiter for the rest: tests/integration/encrypted-columns.test.ts.
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test('args: defaults are a real run with the documented batch and listing cap', () => {
  const parsed = parseRotateArgs([]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.value, {
    dryRun: false,
    acknowledged: false,
    batch: ROTATE_BATCH_DEFAULT,
    limit: ROTATE_LIMIT_DEFAULT,
  });
});

test('args: the acknowledgement flag is the SAME word demo:reset uses', () => {
  const parsed = parseRotateArgs(['--i-know-this-is-production', '--dry-run']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.value.acknowledged, true);
  assert.equal(parsed.ok && parsed.value.dryRun, true);
});

test('args: --batch and --limit take whole numbers, and 0 is a valid limit', () => {
  const parsed = parseRotateArgs(['--batch=500', '--limit=0']);
  assert.equal(parsed.ok && parsed.value.batch, 500);
  assert.equal(parsed.ok && parsed.value.limit, 0);
});

test('args: a typo is refused rather than ignored — including in --dry-run', () => {
  const refused: [readonly string[], string][] = [
    [['--dryrun'], 'unknown_flag'],
    [['-dry-run'], 'unexpected_argument'],
    [['--apply'], 'unknown_flag'],
    [['--batch'], 'missing_value'],
    [['--limit'], 'missing_value'],
    [['--dry-run=1'], 'unexpected_value'],
    [['--batch=abc'], 'invalid_value'],
    [['--batch=0'], 'invalid_value'],
    [['--batch=1.5'], 'invalid_value'],
    [['--batch=99999999'], 'invalid_value'],
    [['--limit=-1'], 'invalid_value'],
    [['--batch='], 'empty_value'],
  ];
  for (const [argv, code] of refused) {
    const parsed = parseRotateArgs(argv);
    assert.equal(parsed.ok, false, `${argv.join(' ')} must be refused`);
    assert.equal((parsed as { ok: false; code: string }).code, code, `${argv.join(' ')} → ${code}`);
  }
});

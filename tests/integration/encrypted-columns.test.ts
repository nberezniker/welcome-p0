import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { getSql, closeSql } from '../../src/lib/db';
import { encryptValue, encryptStored, decryptStored, decryptValue, payloadKeyId } from '../../src/lib/crypto';
import { requireKeyring, requireEncryptionKey } from '../../src/lib/env';
import { ENCRYPTED_COLUMNS, addBatch, emptyCensus, verdictFor, columnLabel } from '../../src/domain/key-rotation';
import { createUser } from './phase3-helpers';

after(async () => {
  await closeSql();
});

/**
 * THE ROTATION REGISTRY AGAINST THE REAL SCHEMA.
 *
 * `scripts/rotate-encryption-key.mts` trusts `ENCRYPTED_COLUMNS` completely: it
 * walks exactly those six columns and reports that every payload has moved to the
 * active key. If the list is wrong, the report is wrong in the worst possible
 * direction — it says "rotation complete" while a column full of rows is still
 * sealed under the key the operator is about to retire, and those rows become
 * unreadable with no warning. Prose cannot hold that; a schema check can.
 *
 * Two invariants, in both directions:
 *   1. every declared column EXISTS, with its declared primary key;
 *   2. no column in `public` that holds ciphertext is MISSING from the registry —
 *      the direction that catches a future migration adding one.
 */

const COLUMN_NAME_HOLDS_CIPHERTEXT = /encrypted/i;

test('rotation registry: every declared column exists, with its declared primary key', async () => {
  const sql = getSql();
  for (const entry of ENCRYPTED_COLUMNS) {
    const column = await sql<{ data_type: string; is_nullable: string }[]>`
      SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${entry.table} AND column_name = ${entry.column}
    `;
    assert.equal(column.length, 1, `${columnLabel(entry)} is not in the schema — the rotation would silently skip it`);
    assert.equal(column[0]!.data_type, 'text', `${columnLabel(entry)} is stored as text ciphertext`);
    assert.equal(
      column[0]!.is_nullable === 'YES',
      entry.nullable,
      `${columnLabel(entry)}: the registry's nullability must match the schema (a NULL is a class, not a gap)`,
    );

    // The identity the report prints and the apply pass selects by. Getting this
    // wrong does not fail loudly — it reports rows that cannot be found.
    const pk = await sql<{ column_name: string }[]>`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public' AND tc.table_name = ${entry.table}
        AND tc.constraint_type = 'PRIMARY KEY'
    `;
    assert.deepEqual(
      pk.map((row) => row.column_name),
      [entry.pk],
      `${columnLabel(entry)}: the registry names ${entry.pk} as the identity, the schema says otherwise`,
    );
  }
});

test('rotation registry: no encrypted column in the schema is missing from the registry', async () => {
  const sql = getSql();
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name ~* 'encrypted'
    ORDER BY table_name, column_name
  `;
  const declared = new Set(ENCRYPTED_COLUMNS.map(columnLabel));
  const undeclared = columns
    .map((row) => `${row.table_name}.${row.column_name}`)
    .filter((label) => !declared.has(label));
  assert.deepEqual(
    undeclared,
    [],
    'a column that holds ciphertext must be in ENCRYPTED_COLUMNS (src/domain/key-rotation.ts), or a key ' +
      'rotation will leave it sealed under the retired key and report success',
  );
  // The regex is the guard, not a coincidence of naming: it matched something.
  assert.ok(columns.some((row) => COLUMN_NAME_HOLDS_CIPHERTEXT.test(row.column_name)));
});

test('rotation: a payload written the LEGACY way is read through the keyring, and vice versa', async () => {
  // This is the seeds'/sweep-to-application compatibility claim, exercised through
  // a real row rather than in memory: `scripts/seed-demo.mts` and
  // `scripts/usage-matrix.mts` seal values with a raw env key and the `v1` id, and
  // the application now reads them through the keyring.
  const sql = getSql();
  const user = await createUser('rotation-compat');
  const keyring = requireKeyring();
  const envKey = requireEncryptionKey();
  const legacyPayload = encryptValue('legacy-written@example.org', envKey);
  assert.equal(payloadKeyId(legacyPayload), 'v1');

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO contact_fields (profile_id, kind, encrypted_value, public_enabled)
    VALUES (${user.profileId}, 'phone', ${legacyPayload}, false)
    RETURNING id
  `;
  const stored = await sql<{ encrypted_value: string }[]>`
    SELECT encrypted_value FROM contact_fields WHERE id = ${inserted[0]!.id}
  `;
  assert.equal(decryptStored(stored[0]!.encrypted_value, keyring), 'legacy-written@example.org');

  // And the reverse direction: what the keyring writes today is what the legacy
  // reader (the integration suite's fixtures, the older tooling) can open.
  const writtenByKeyring = encryptStored('keyring-written@example.org', keyring);
  const second = await sql<{ id: string }[]>`
    INSERT INTO contact_fields (profile_id, kind, encrypted_value, public_enabled)
    VALUES (${user.profileId}, 'whatsapp', ${writtenByKeyring}, false)
    RETURNING id
  `;
  assert.equal(decryptValue(writtenByKeyring, envKey), 'keyring-written@example.org');

  // Both rows, censused the way the rotation command reads them: current, not
  // stale, and therefore nothing for a rotation to rewrite.
  const rows = await sql<{ pk: string; payload: string | null }[]>`
    SELECT id AS pk, encrypted_value AS payload FROM contact_fields
    WHERE id IN (${inserted[0]!.id}, ${second[0]!.id})
    ORDER BY id
  `;
  const census = addBatch(emptyCensus(), rows, keyring, 20);
  assert.equal(census.scanned, 2);
  assert.equal(census.counts.current, 2, 'both ids are v1, the active one, so a rotation has nothing to do');
  // `stillNamed` is asked about a RETIRED id — the one an operator would be
  // considering dropping. Nothing names v0, so the answer is empty; asking about
  // v1 here would be asking about the active key, which is never retired.
  assert.deepEqual(verdictFor([census], ['v0']), { complete: true, stale: 0, unreadable: 0, stillNamed: [] });
  assert.deepEqual(census.byKeyId, { v1: 2 });
});

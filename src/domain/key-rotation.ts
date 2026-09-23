/**
 * Key rotation — WHAT is encrypted, WHAT STATE each stored payload is in, and
 * what the operator is told about it. Pure: no database, no env, no Next.js.
 *
 * WHY THIS MODULE EXISTS. `scripts/rotate-encryption-key.mts` rewrites ciphertext
 * in six columns of five tables. Two things have to be true for that to be
 * something an operator can run against a real database:
 *
 *   1. THE LIST OF COLUMNS IS DATA, NOT PROSE. A rotation that misses a column
 *      leaves rows that can no longer be read the moment the old key is retired,
 *      and the miss is invisible until a feature breaks months later —
 *      `tests/integration/encrypted-columns.test.ts` therefore checks this
 *      registry against `information_schema`, so a renamed or added column is a
 *      failing test rather than a silent gap.
 *
 *   2. EVERY ROW IS CLASSIFIED, AND THE ONES THIS COMMAND WILL NOT TOUCH ARE
 *      NAMED. "412 rows, 7 rewritten" is not an operator report: it says nothing
 *      about the other 405, and it cannot be acted on when the number is wrong.
 *      So a census counts every row into exactly one class (including NULL, so
 *      the classes ADD UP to the row count) and, for every class that needs a
 *      human, prints the primary keys — never the values, which are the one
 *      thing in these tables that must not reach a terminal or a log.
 *
 * The classification READS every payload under the id it names (one AES-GCM open
 * per row), which is what lets `current` mean "readable by this deployment" and
 * `stale` mean "proven re-encryptable" rather than "the id looks acceptable". A
 * census that reported rows as healthy without reading them would be asserting,
 * not verifying — and the case it would miss (an id repointed at different key
 * material) is exactly the mistake that makes stored data unreadable.
 */

import { decryptStored, encryptStored, payloadKeyId, type Keyring } from '../lib/crypto';
import { PRODUCTION_ACK_FLAG } from './production-guard';

// ---------------------------------------------------------------------------
// What is encrypted at rest
// ---------------------------------------------------------------------------

export interface EncryptedColumn {
  readonly table: string;
  readonly column: string;
  /** The single-column primary key, used to select and to identify a row. */
  readonly pk: string;
  /** What the ciphertext holds, for the operator reading the report. */
  readonly holds: string;
  /** True when the column may be NULL — a NULL is not a ciphertext and has no class. */
  readonly nullable: boolean;
}

/**
 * The six columns, five tables.
 *
 * `mfa_credentials` is keyed by `account_id` (one TOTP credential per account),
 * and `oauth_flow_states` by `jti` (a random 128-bit id) — not every table has an
 * `id`, which is why the primary key is part of each entry rather than assumed.
 *
 * The key's OTHER role is deliberately absent from this list because it is not a
 * column: the OAuth `state` MAC is derived from the key with HKDF
 * (src/lib/oauth-state.ts) and is NOT rotated with these values — a decision,
 * with its user-visible window, in
 * docs-internal/security/KEY_ROTATION_ASSESSMENT.md.
 */
export const ENCRYPTED_COLUMNS: readonly EncryptedColumn[] = [
  {
    table: 'contact_fields',
    column: 'encrypted_value',
    pk: 'id',
    holds: 'a contact value (phone, whatsapp, a link…)',
    nullable: false,
  },
  {
    table: 'registrations',
    column: 'encrypted_email',
    pk: 'id',
    holds: 'the email imported from a registration CSV',
    nullable: true,
  },
  {
    table: 'mfa_credentials',
    column: 'secret_encrypted',
    pk: 'account_id',
    holds: 'the TOTP shared secret',
    nullable: false,
  },
  {
    table: 'oauth_grants',
    column: 'access_token_encrypted',
    pk: 'id',
    holds: 'a Google access token',
    nullable: false,
  },
  {
    table: 'oauth_grants',
    column: 'refresh_token_encrypted',
    pk: 'id',
    holds: 'a Google refresh token',
    nullable: true,
  },
  {
    table: 'oauth_flow_states',
    column: 'code_verifier_encrypted',
    pk: 'jti',
    holds: 'the PKCE code verifier of an in-flight flow',
    nullable: false,
  },
];

/** `table.column`, the label every line of the report uses. */
export function columnLabel(entry: EncryptedColumn): string {
  return `${entry.table}.${entry.column}`;
}

// ---------------------------------------------------------------------------
// The classes
// ---------------------------------------------------------------------------

/**
 * The four classes a stored payload can be in, plus `null` for "no value at all".
 *
 *   current  names the ACTIVE key's id and opens under it — nothing to do.
 *   stale    names another id THE KEYRING HAS, and opens under that id: these are
 *            the rows this command rewrites.
 *   foreign  names an id the keyring does NOT have: unreadable here. Restoring
 *            the key to ENCRYPTION_KEYS makes it readable again, and this command
 *            will NOT touch it — rewriting a payload it cannot read would destroy
 *            data, so it refuses to guess.
 *   corrupt  is not `<id>.<iv>.<ct>.<tag>`, or does not open under the very id it
 *            names (tampered, or that id was pointed at different key material).
 *            Also never touched.
 *   null     the column value is NULL — counted so the classes add up to the row
 *            count, and never reported as unreadable.
 */
export type PayloadClass = 'current' | 'stale' | 'foreign' | 'corrupt';
export type StoredValueClass = PayloadClass | 'null';

export const PAYLOAD_CLASSES: readonly PayloadClass[] = ['current', 'stale', 'foreign', 'corrupt'];

/** The two classes this command cannot read, and therefore refuses to touch. */
export const UNREADABLE_CLASSES: readonly PayloadClass[] = ['foreign', 'corrupt'];

export interface RowRef {
  readonly pk: string;
  /** The key id the payload names, or null when it is not a payload at all. */
  readonly keyId: string | null;
}

export interface ColumnCensus {
  /** Rows looked at, i.e. `SELECT count(*)` of the table. */
  readonly scanned: number;
  readonly counts: Record<StoredValueClass, number>;
  /** Primary keys per class, capped at the report's limit (the count remains exact). */
  readonly rowRefs: Record<PayloadClass, RowRef[]>;
  /** Payloads per key id — the number a key must read ZERO in before it is retired. */
  readonly byKeyId: Record<string, number>;
}

export function emptyCensus(): ColumnCensus {
  return {
    scanned: 0,
    counts: { current: 0, stale: 0, foreign: 0, corrupt: 0, null: 0 },
    rowRefs: { current: [], stale: [], foreign: [], corrupt: [] },
    byKeyId: {},
  };
}

/** One value's class, with NULL as its own class. */
export function classifyStoredValue(payload: string | null, keyring: Keyring): StoredValueClass {
  return payload === null ? 'null' : classifyPayload(payload, keyring);
}

/**
 * The class of a value that is actually present — one of the four payload
 * classes.
 *
 * EVERY PAYLOAD IS READ, the active id included, and that is deliberate: `current`
 * has to mean "this deployment can read this row", not "this row's id looks
 * right". The case the extra read catches is an id pointed at different key
 * material without the id changing (change `ENCRYPTION_KEY` but not
 * `ENCRYPTION_KEY_ID`): classifying by id alone would report every row affected
 * by that mistake as current — i.e. healthy — while nothing could read them. A
 * census exists to verify, not to assume.
 *
 * A STALE row is one that names a non-active id the keyring holds AND opens under
 * it, so "stale" means "proven re-encryptable": the apply pass never discovers
 * halfway through a write that a row it selected cannot be read.
 */
export function classifyPayload(payload: string, keyring: Keyring): PayloadClass {
  const id = payloadKeyId(payload);
  if (id === null) return 'corrupt';
  if (!keyring.keys.has(id)) return 'foreign';
  if (!readStoredValue(payload, keyring).ok) return 'corrupt';
  return id === keyring.active ? 'current' : 'stale';
}

export type ReadResult = { ok: true; plaintext: string } | { ok: false; reason: string };

/** Opens a payload under the key its id names, without throwing — the caller reports. */
export function readStoredValue(payload: string, keyring: Keyring): ReadResult {
  try {
    return { ok: true, plaintext: decryptStored(payload, keyring) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export type ReencryptResult = { ok: true; payload: string } | { ok: false; reason: string };

/**
 * The rewrite itself, as a pure function: open the payload under the id it names,
 * seal it again under the active key. Both failures are returned rather than
 * thrown, because the caller's job is to REPORT them per row.
 */
export function reencryptStoredValue(payload: string, keyring: Keyring): ReencryptResult {
  const read = readStoredValue(payload, keyring);
  return read.ok ? { ok: true, payload: encryptStored(read.plaintext, keyring) } : read;
}

/**
 * Adds a batch of rows to a census. `limit <= 0` lists every primary key;
 * otherwise each class keeps the first `limit` keys in the order scanned
 * (primary-key order), and the exact count stays in `counts`.
 */
export function addBatch(
  census: ColumnCensus,
  rows: readonly { pk: string; payload: string | null }[],
  keyring: Keyring,
  limit: number,
): ColumnCensus {
  const counts = { ...census.counts };
  const rowRefs: Record<PayloadClass, RowRef[]> = {
    current: [...census.rowRefs.current],
    stale: [...census.rowRefs.stale],
    foreign: [...census.rowRefs.foreign],
    corrupt: [...census.rowRefs.corrupt],
  };
  const byKeyId = { ...census.byKeyId };
  let scanned = census.scanned;

  for (const row of rows) {
    scanned += 1;
    if (row.payload === null) {
      counts.null += 1; // no ciphertext, no identity, and never reported as unreadable
      continue;
    }
    const cls = classifyPayload(row.payload, keyring);
    counts[cls] += 1;
    const keyId = payloadKeyId(row.payload);
    if (keyId !== null) byKeyId[keyId] = (byKeyId[keyId] ?? 0) + 1;
    if (limit <= 0 || rowRefs[cls].length < limit) rowRefs[cls].push({ pk: row.pk, keyId });
  }

  return { scanned, counts, rowRefs, byKeyId };
}

/** The classes a column has rows in that the operator must be told about. */
export function actionableClasses(census: ColumnCensus): PayloadClass[] {
  return PAYLOAD_CLASSES.filter((cls) => census.counts[cls] > 0 && cls !== 'current');
}

export interface RotationVerdict {
  /** True when nothing is left that this command could rewrite (stale 0 everywhere). */
  readonly complete: boolean;
  readonly stale: number;
  readonly unreadable: number;
  /**
   * Retired ids that payloads STILL NAME, with how many rows name each. This is
   * the honest form of "reads zero in every column": a row that names the id but
   * cannot be read under it is not stale (nothing to rewrite) and not safe to
   * forget either — retiring the id silently leaves it behind, and the report has
   * to say so rather than print a zero.
   */
  readonly stillNamed: readonly { id: string; rows: number }[];
}

/**
 * A rotation is complete when every column reads ZERO stale rows. Unreadable rows
 * are counted separately and do NOT block it: retiring a key cannot make an
 * already-unreadable row worse, and pretending otherwise would leave an operator
 * unable to finish. They block the operator's ATTENTION instead, which is what
 * the report's detail blocks and `stillNamed` are for.
 */
export function verdictFor(censuses: readonly ColumnCensus[], retiredIds: readonly string[] = []): RotationVerdict {
  let stale = 0;
  let unreadable = 0;
  for (const census of censuses) {
    stale += census.counts.stale;
    unreadable += UNREADABLE_CLASSES.reduce((sum, cls) => sum + census.counts[cls], 0);
  }
  const stillNamed = retiredIds
    .map((id) => ({ id, rows: censuses.reduce((sum, census) => sum + (census.byKeyId[id] ?? 0), 0) }))
    .filter((entry) => entry.rows > 0);
  return { complete: stale === 0, stale, unreadable, stillNamed };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * The line the report prints under its table, so the two unreadable columns are
 * named for what they mean rather than left to be inferred.
 */
export const CENSUS_LEGEND =
  'current = names the active key AND opens under it; stale = names another readable key and opens under it.\n' +
  'unreadable = foreign (the keyring has no key with that id) + corrupt (not a payload, or it does not ' +
  'decrypt under the id it names). Both are REPORTED and neither is ever rewritten.';

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

function count(value: number, width: number): string {
  return String(value).padStart(width, ' ');
}

/** The widths are derived from the registry so a new column cannot misalign the table. */
function labelWidth(): number {
  return Math.max(...ENCRYPTED_COLUMNS.map((entry) => columnLabel(entry).length));
}

export function formatCensusHeader(): string {
  return (
    `${pad('table.column', labelWidth())}  ${pad('rows', 4)}  ${pad('current', 7)}  ${pad('stale', 5)}  ` +
    `${pad('foreign', 7)}  ${pad('corrupt', 7)}  ${pad('null', 4)}`
  );
}

export function formatCensusRow(entry: EncryptedColumn, census: ColumnCensus): string {
  return (
    `${pad(columnLabel(entry), labelWidth())}  ${count(census.scanned, 4)}  ${count(census.counts.current, 7)}  ` +
    `${count(census.counts.stale, 5)}  ${count(census.counts.foreign, 7)}  ${count(census.counts.corrupt, 7)}  ` +
    `${count(census.counts.null, 4)}`
  );
}

/**
 * The identity half of the report: for every class that needs a human, the
 * primary keys, and — for the classes this command will not touch — the key id
 * each row names, because that is what the operator has to act on.
 *
 * The listing is bounded by `addBatch`'s limit; the tail is replaced by the exact
 * remainder and the flag that shows it, so "7 rows" is never a dead end.
 */
export function formatColumnDetail(entry: EncryptedColumn, census: ColumnCensus): string[] {
  const classes = actionableClasses(census);
  if (classes.length === 0) return [];
  const lines = [`  ${columnLabel(entry)} — ${entry.holds}`];
  for (const cls of classes) {
    const total = census.counts[cls];
    const refs = census.rowRefs[cls];
    const kind =
      cls === 'stale'
        ? 'to be rewritten under the active key'
        : cls === 'foreign'
          ? 'the keyring has no key with that id — this command will NOT touch these'
          : 'not a payload, or undecryptable under the id each row names — this command will NOT touch these';
    lines.push(`    ${cls.toUpperCase()} ${total} — ${kind}`);
    for (const ref of refs) {
      lines.push(`      ${pad(entry.pk, 12)} ${ref.pk}${ref.keyId === null ? '' : `   ← key id ${ref.keyId}`}`);
    }
    if (total > refs.length) {
      lines.push(`      … and ${total - refs.length} more — list them all with --limit=0`);
    }
  }
  return lines;
}

/**
 * Rows per key id, per column. This is the line the assessment requires before a
 * key is retired: it must read ZERO for that id, in every column, or the rows
 * behind the number are about to become unreadable.
 *
 * An id the keyring does NOT hold is listed too — a foreign payload still names an
 * id, and hiding it would mean a retirement check that reads zero for an id which
 * rows in fact mention. Everything else is accounted for on the same line: `null`
 * for the empty column values, and `not a payload` for rows with no id at all, so
 * the numbers here add up to the row count of the table.
 */
export function formatKeyIdCensus(censuses: readonly { entry: EncryptedColumn; census: ColumnCensus }[]): string[] {
  const lines = ['rows by key id (retire an id only when it reads 0 in every column):'];
  let printed = false;
  for (const { entry, census } of censuses) {
    const ids = Object.keys(census.byKeyId).sort();
    if (ids.length === 0 && census.counts.null === 0 && census.counts.corrupt === 0) continue;
    printed = true;
    const parts = ids.map((id) => `${id} ${census.byKeyId[id]}`);
    if (census.counts.null > 0) parts.push(`null ${census.counts.null}`);
    if (census.counts.corrupt > 0) parts.push(`not a payload ${census.counts.corrupt}`);
    lines.push(`  ${pad(columnLabel(entry), labelWidth())}  ${parts.join('  ·  ')}`);
  }
  if (!printed) lines.push('  (no payloads in any column)');
  return lines;
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

export interface RotateArgs {
  dryRun: boolean;
  acknowledged: boolean;
  /** Rows per transaction. */
  batch: number;
  /** Primary keys printed per class; 0 lists all of them. */
  limit: number;
}

export const ROTATE_BATCH_DEFAULT = 200;
export const ROTATE_LIMIT_DEFAULT = 20;
export const ROTATE_BATCH_MAX = 10_000;
export const ROTATE_LIMIT_MAX = 100_000;

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/**
 * Reads a value flag, applying the default when it was not given at all. A flag
 * that IS given with a bad value is a refusal rather than a fallback: silently
 * substituting the default for `--batch=abc` would run a rotation the operator did
 * not ask for.
 */
function batchOrLimit(
  raw: string | null,
  name: string,
  min: number,
  max: number,
  fallback: number,
): Parsed<number> {
  if (raw === null) return { ok: true, value: fallback };
  if (raw.trim().length === 0) {
    return { ok: false, code: 'empty_value', message: `${name}= requires a whole number` };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return {
      ok: false,
      code: 'invalid_value',
      message: `${name}= takes a whole number in [${min}, ${max}] — got ${JSON.stringify(raw)}`,
    };
  }
  return { ok: true, value };
}

/**
 * Parses the command line. Same stance as `pnpm demo:reset`: a flag this command
 * does not know, or a known flag with the wrong shape, is a REFUSAL rather than
 * something to ignore — a typo in `--dry-run` must never turn into a real write,
 * and a typo in `--batch` must never silently become the default.
 */
export function parseRotateArgs(argv: readonly string[]): Parsed<RotateArgs> {
  const flags = new Set(['--dry-run', PRODUCTION_ACK_FLAG]);
  const valueFlags = new Set(['--batch', '--limit']);

  for (const arg of argv) {
    if (!arg.startsWith('--')) return { ok: false, code: 'unexpected_argument', message: `unexpected argument: ${arg}` };
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!flags.has(name) && !valueFlags.has(name)) {
      return { ok: false, code: 'unknown_flag', message: `unknown flag: ${name}` };
    }
    if (valueFlags.has(name) && eq === -1) {
      return { ok: false, code: 'missing_value', message: `${name} needs a value: ${name}=…` };
    }
    if (flags.has(name) && eq !== -1) {
      return { ok: false, code: 'unexpected_value', message: `${name} takes no value` };
    }
  }

  const read = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? null : hit.slice(name.length + 3);
  };

  const batch = batchOrLimit(read('batch'), '--batch', 1, ROTATE_BATCH_MAX, ROTATE_BATCH_DEFAULT);
  if (!batch.ok) return batch;
  const limit = batchOrLimit(read('limit'), '--limit', 0, ROTATE_LIMIT_MAX, ROTATE_LIMIT_DEFAULT);
  if (!limit.ok) return limit;

  return {
    ok: true,
    value: {
      dryRun: argv.includes('--dry-run'),
      acknowledged: argv.includes(PRODUCTION_ACK_FLAG),
      batch: batch.value,
      limit: limit.value,
    },
  };
}

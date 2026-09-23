#!/usr/bin/env node
/**
 * `pnpm key:rotate` — re-encrypt the six encrypted columns under the ACTIVE key.
 *
 * THE PROBLEM IT SOLVES. Every secret at rest is sealed with one AES-256-GCM key,
 * and each payload names the key id that sealed it (`<id>.<iv>.<ct>.<tag>` — the
 * slot that used to be a hard-coded `v1`). A deployment that adds a key and moves
 * the active id forward can WRITE under the new key immediately, because old rows
 * stay readable: both ids are in the keyring (src/lib/crypto.ts). What is left is
 * this command — moving the rows that are still under the old id, so the old key
 * can be retired. Until they are moved, the old key is load-bearing.
 *
 * WHAT IT DOES, in two passes over `src/domain/key-rotation.ts`'s registry:
 *   · CENSUS — reads every row of every encrypted column and classifies the value
 *     into exactly one class (current / stale / foreign / corrupt / null) by the id
 *     it names. Prints the counts per column per class, and, for the classes that
 *     need a human, the PRIMARY KEYS — never a value, never a key (the one thing
 *     in these tables that must not reach a terminal or a log). Unreadable rows
 *     are named rather than summarised, and this command never rewrites them:
 *     rewriting a payload it cannot read would destroy data.
 *   · APPLY (skipped under --dry-run) — for every row whose payload names a
 *     non-active id the keyring HAS, decrypt under that id, seal under the active
 *     key, and write it back with a compare-and-swap (`WHERE pk = … AND col = …`),
 *     so a row that changed since the read is skipped rather than clobbered.
 *     Batched, one short transaction per batch, no long-running transaction.
 * Then it censuses again and requires the stale count to be zero: an interrupted
 * run leaves rows, never a half-written row, and re-running is all recovery is.
 *
 * THE GUARDS, IN ORDER — the first two before any connection:
 *   1. every flag must be known and correctly shaped (a typo in --dry-run must
 *      never become a write);
 *   2. if the target looks production-like (APP_ENV=production, a non-local
 *      database host, or an unreadable database URL) the run must be explicitly
 *      acknowledged with `--i-know-this-is-production` — the same flag, and the
 *      same definition of "production-like", as `pnpm demo:reset`
 *      (src/domain/production-guard.ts);
 *   3. the keyring must be valid: a malformed id, a duplicate id, or an
 *      ENCRYPTION_KEYS value that names the active id is a refusal naming what is
 *      wrong (src/lib/crypto.ts parseKeyring). Key material is never printed.
 *
 * USAGE:
 *   pnpm key:rotate --dry-run [--limit=N]              # what would change, and what cannot be read
 *   pnpm key:rotate [--i-know-this-is-production] [--batch=N] [--limit=N]
 *   pnpm key:rotate --dry-run --limit=0                # list every primary key, not just the first 20
 *
 * Position in a rotation (docs-internal/ops/RUNBOOK.md §5):
 *   expand (add the new key, keep the old active) → flip (ENCRYPTION_KEY + ID) →
 *   BACKFILL (this command, until --dry-run reads zero stale) → contract (drop the
 *   old key from ENCRYPTION_KEYS). Steps 2 and 3 may overlap: the apply pass only
 *   ever selects rows whose id is a non-active key the keyring still holds.
 *
 * The database target is DATABASE_URL, or NEON_CONN_DIRECT for this deployment's
 * live database; only `host:port/database` is ever printed.
 *
 * EXIT CODES: 0 = done (including "there was nothing to rewrite"); 2 = refused
 * before connecting; 1 = unexpected failure, or the post-write census still shows
 * stale rows.
 */
import postgres from 'postgres';
import { parseKeyring, type Keyring } from '../src/lib/crypto.ts';
import {
  CENSUS_LEGEND,
  ENCRYPTED_COLUMNS,
  addBatch,
  columnLabel,
  emptyCensus,
  formatCensusHeader,
  formatCensusRow,
  formatColumnDetail,
  formatKeyIdCensus,
  parseRotateArgs,
  reencryptStoredValue,
  verdictFor,
  type ColumnCensus,
  type EncryptedColumn,
} from '../src/domain/key-rotation.ts';
import { PRODUCTION_ACK_FLAG, looksProductionLike } from '../src/domain/production-guard.ts';

interface Row {
  pk: string;
  payload: string | null;
}

function refuse(exitCode: number, message: string): never {
  console.error(`\n${message}\n`);
  process.exit(exitCode);
}

/** host:port/dbname only — credentials and key material never reach the terminal. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '(unparsable DATABASE_URL)';
  }
}

const parsed = parseRotateArgs(process.argv.slice(2));
if (!parsed.ok) {
  refuse(
    2,
    `${parsed.message}\n\nUsage: pnpm key:rotate [--dry-run] [${PRODUCTION_ACK_FLAG}] [--batch=N] [--limit=N]`,
  );
}
const args = parsed.value;

const databaseUrl =
  process.env.DATABASE_URL || process.env.NEON_CONN_DIRECT || 'postgres://localhost:5432/welcome_dev';
const productionLike = looksProductionLike({ appEnv: process.env.APP_ENV, databaseUrl });
if (productionLike && !args.acknowledged) {
  refuse(
    2,
    `REFUSED: the target looks production-like (APP_ENV=${process.env.APP_ENV ?? 'unset'}, database host not local). ` +
      `Re-run with ${PRODUCTION_ACK_FLAG} if you really mean to rewrite ciphertext there.`,
  );
}

const keyringParse = parseKeyring({
  encryptionKey: process.env.ENCRYPTION_KEY,
  encryptionKeys: process.env.ENCRYPTION_KEYS,
  activeKeyId: process.env.ENCRYPTION_KEY_ID,
});
if (!keyringParse.ok) refuse(2, `REFUSED: ${keyringParse.message}`);
const keyring: Keyring = keyringParse.keyring;

const retiredIds = [...keyring.keys.keys()].filter((id) => id !== keyring.active).sort();

/** One page of a column, in primary-key order. Short statement, no open cursor. */
async function readPage(
  sql: postgres.Sql,
  entry: EncryptedColumn,
  after: string | null,
): Promise<Row[]> {
  return sql<Row[]>`
    SELECT ${sql(entry.pk)} AS pk, ${sql(entry.column)} AS payload
    FROM ${sql(entry.table)}
    WHERE ${after === null ? sql`true` : sql`${sql(entry.pk)} > ${after}`}
    ORDER BY ${sql(entry.pk)}
    LIMIT ${args.batch}
  `;
}

/** Every row of a column, classified. The report is built from this and nothing else. */
async function censusColumn(sql: postgres.Sql, entry: EncryptedColumn): Promise<ColumnCensus> {
  let census = emptyCensus();
  let after: string | null = null;
  for (;;) {
    const page = await readPage(sql, entry, after);
    if (page.length === 0) break;
    census = addBatch(census, page, keyring, args.limit);
    after = page[page.length - 1]!.pk;
  }
  return census;
}

interface ApplyCounts {
  rewritten: number;
  skippedUnreadable: number;
  skippedConcurrent: number;
}

/**
 * The rows this command may rewrite: payloads whose id is a non-active key the
 * keyring holds. `foreign` and `corrupt` rows are never selected — they are
 * reported by the census and left exactly as they are.
 */
async function applyColumn(sql: postgres.Sql, entry: EncryptedColumn): Promise<ApplyCounts> {
  const counts: ApplyCounts = { rewritten: 0, skippedUnreadable: 0, skippedConcurrent: 0 };
  let after: string | null = null;

  for (;;) {
    const page = await sql<Row[]>`
      SELECT ${sql(entry.pk)} AS pk, ${sql(entry.column)} AS payload
      FROM ${sql(entry.table)}
      WHERE ${sql(entry.column)} IS NOT NULL
        AND split_part(${sql(entry.column)}, '.', 1) = ANY(${retiredIds})
        AND ${after === null ? sql`true` : sql`${sql(entry.pk)} > ${after}`}
      ORDER BY ${sql(entry.pk)}
      LIMIT ${args.batch}
    `;
    if (page.length === 0) break;
    after = page[page.length - 1]!.pk;

    // One short transaction per page: the whole page is rewritten, or none of it.
    await sql.begin(async (tx) => {
      for (const row of page) {
        const payload = row.payload!;
        const rewritten = reencryptStoredValue(payload, keyring);
        if (!rewritten.ok) {
          counts.skippedUnreadable += 1;
          continue;
        }
        // Compare-and-swap: a row that changed since the read is left alone rather
        // than clobbered. The alternative (re-read, then write) is the same thing
        // with a wider window.
        const updated = await tx<{ one: number }[]>`
          UPDATE ${sql(entry.table)}
          SET ${sql(entry.column)} = ${rewritten.payload}
          WHERE ${sql(entry.pk)} = ${row.pk} AND ${sql(entry.column)} = ${payload}
          RETURNING 1 AS one
        `;
        if (updated.length > 0) counts.rewritten += 1;
        else counts.skippedConcurrent += 1;
      }
    });
  }
  return counts;
}

console.log('KEY ROTATION — re-encrypt stored secrets under the active key');
console.log('===========================================================');
console.log(`target       ${describeTarget(databaseUrl)} (APP_ENV=${process.env.APP_ENV ?? 'unset'})`);
console.log(`mode         ${args.dryRun ? 'DRY RUN — nothing will be written' : 'APPLY'}`);
console.log(
  `production   ${productionLike ? `PRODUCTION-LIKE — acknowledged with ${PRODUCTION_ACK_FLAG}` : 'looks local'}`,
);
console.log(`keyring      active ${keyring.active} · readable ${[...keyring.keys.keys()].sort().join(', ')}`);
console.log(
  retiredIds.length === 0
    ? 'rotation     no retired key ids — every payload already names the active key; this run only reports.'
    : `rotation     rewriting id(s) ${retiredIds.join(', ')} → ${keyring.active}`,
);
console.log(`scope        ${ENCRYPTED_COLUMNS.length} columns of ${new Set(ENCRYPTED_COLUMNS.map((c) => c.table)).size} tables, batched by primary key (batch=${args.batch})`);
console.log(`identity     up to ${args.limit === 0 ? 'ALL' : args.limit} primary key(s) per class per column; values are never printed`);
console.log('');

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
let exitCode = 0;

try {
  console.log('CENSUS BEFORE');
  console.log(formatCensusHeader());
  const before: { entry: EncryptedColumn; census: ColumnCensus }[] = [];
  for (const entry of ENCRYPTED_COLUMNS) {
    const census = await censusColumn(sql, entry);
    before.push({ entry, census });
    console.log(formatCensusRow(entry, census));
  }
  console.log('');
  console.log(CENSUS_LEGEND);
  console.log('');
  for (const { entry, census } of before) {
    for (const line of formatColumnDetail(entry, census)) console.log(line);
  }
  console.log('');
  for (const line of formatKeyIdCensus(before)) console.log(line);
  console.log('');

  const beforeVerdict = verdictFor(before.map((b) => b.census), retiredIds);
  console.log(
    `CENSUS VERDICT: ${beforeVerdict.stale} row(s) this command can rewrite · ` +
      `${beforeVerdict.unreadable} unreadable row(s) it will not touch` +
      (beforeVerdict.stillNamed.length > 0
        ? ` · ids still named: ${beforeVerdict.stillNamed.map((s) => `${s.id} ${s.rows}`).join(', ')}`
        : ''),
  );
  console.log('');
  console.log(
    'WHY THE UNREADABLE ONES ARE NOT TOUCHED: a payload this deployment cannot read cannot be ' +
      're-encrypted. Rewriting it would mean inventing a value or dropping the row — both are data ' +
      'destruction, and neither is what an operator asked for by rotating a key. They are listed ' +
      'above with their primary keys so they can be dealt with directly (usually by putting the ' +
      'right key back into ENCRYPTION_KEYS).',
  );
  console.log('');

  if (args.dryRun) {
    console.log('DRY RUN: nothing was written.');
    if (beforeVerdict.complete) console.log('Nothing to rewrite: no payload names a key other than the active one.');
    else console.log('Re-run without --dry-run to rewrite exactly the STALE rows listed above.');
  } else if (beforeVerdict.complete) {
    console.log('Nothing to rewrite: no payload names a key other than the active one.');
  } else {
    console.log('APPLY');
    console.log('-----');
    const applied: { entry: EncryptedColumn; counts: ApplyCounts }[] = [];
    const applyLabel = Math.max(...ENCRYPTED_COLUMNS.map((entry) => columnLabel(entry).length)) + 2;
    for (const entry of ENCRYPTED_COLUMNS) {
      const counts = await applyColumn(sql, entry);
      applied.push({ entry, counts });
      console.log(
        `  ${columnLabel(entry).padEnd(applyLabel)} rewritten ${counts.rewritten}` +
          `${counts.skippedUnreadable ? ` · unreadable, left alone ${counts.skippedUnreadable}` : ''}` +
          `${counts.skippedConcurrent ? ` · changed under us, left alone ${counts.skippedConcurrent}` : ''}`,
      );
    }
    console.log('');

    // The verification is the census again: the claim "nothing is left on the old
    // key" is only worth as much as the pass that measures it.
    console.log('CENSUS AFTER');
    console.log(formatCensusHeader());
    const after: { entry: EncryptedColumn; census: ColumnCensus }[] = [];
    for (const entry of ENCRYPTED_COLUMNS) {
      const census = await censusColumn(sql, entry);
      after.push({ entry, census });
      console.log(formatCensusRow(entry, census));
    }
    console.log('');
    console.log(CENSUS_LEGEND);
    console.log('');
    for (const line of formatKeyIdCensus(after)) console.log(line);
    console.log('');

    const afterVerdict = verdictFor(after.map((a) => a.census), retiredIds);
    const rewrittenTotal = applied.reduce((sum, a) => sum + a.counts.rewritten, 0);
    console.log(`REWRITTEN: ${rewrittenTotal} row(s) now name the active key ${keyring.active}.`);

    if (!afterVerdict.complete) {
      console.error(
        `\nVERIFICATION FAILED: ${afterVerdict.stale} row(s) still name a retired key. The run was ` +
          'interrupted or a concurrent writer recreated them; re-run this command.',
      );
      exitCode = 1;
    } else if (afterVerdict.unreadable !== beforeVerdict.unreadable) {
      console.error(
        `\nVERIFICATION FAILED: unreadable rows went from ${beforeVerdict.unreadable} to ` +
          `${afterVerdict.unreadable}. This command does not touch them, so something else changed ` +
          'these rows while it ran.',
      );
      exitCode = 1;
    } else {
      if (afterVerdict.stillNamed.length === 0) {
        console.log(
          `Rotation complete: every column reads 0 rows under ${retiredIds.join(', ')}. Retire an id by ` +
            'removing it from ENCRYPTION_KEYS — not before.',
        );
      } else {
        // The precise form of "reads zero": no REWRITABLE row is left, but rows
        // still name the retired id and cannot be read under it. Printing a zero
        // here would be the assertion this command exists to avoid.
        for (const { id, rows } of afterVerdict.stillNamed) {
          console.log(
            `NOTHING LEFT TO REWRITE, BUT NOT A ZERO: ${rows} row(s) still name the id ${id}. They are ` +
              'not stale — they cannot be read under that id at all, so there is nothing to rewrite — and ' +
              'retiring the id will neither fix them nor make them worse. They need the key that sealed ' +
              'them (put it back into ENCRYPTION_KEYS); the census above lists them by primary key.',
          );
        }
      }
      if (afterVerdict.unreadable > 0) {
        console.log(
          `\nNOTE: ${afterVerdict.unreadable} unreadable row(s) remain (listed in the census above). They ` +
            'are not affected by retiring a key — they are already unreadable — but they are also not ' +
            'fixed by this command, and nothing else in this repository can read them either.',
        );
      }
    }
  }
} catch (error) {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

process.exit(exitCode);

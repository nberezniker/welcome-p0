#!/usr/bin/env node
// WELCOME — legacy v1/v2 tags → taxonomy v3 backfill (pass A: the interest axis).
//
// Maps the legacy offer_tags / need_tags columns of BOTH profiles and
// event_memberships onto the v3 INTEREST axis through the catalogue aliases
// (src/domain/taxonomy.ts is the only arbiter of what an id means):
//   tag resolves to a catalogue interest → merged into `interests`
//   tag resolves to nothing              → demoted to `keywords`
// The legacy columns are READ-ONLY here: offer_tags / need_tags are never
// modified, so the frozen scorePair core and the organizer export keep working.
//
// Guarantees:
//   - idempotent — a second run finds every row already up to date and writes
//     nothing. Merge, never overwrite: existing v3 values win and cap the list,
//     so user-entered v3 data is never lost or reordered.
//   - deterministic — interests are added in catalogue order, keywords in tag
//     order; repeated runs produce byte-identical arrays.
//   - refuses APP_ENV=production unless --allow-production is passed explicitly.
//
// Usage:
//   node --import tsx scripts/migrate-tags-to-v3.mts --dry-run
//   DATABASE_URL=postgres://localhost:5432/welcome_test APP_ENV=development \
//     node --import tsx scripts/migrate-tags-to-v3.mts --dry-run
//   node --env-file-if-exists=.env.local --import tsx scripts/migrate-tags-to-v3.mts
//
// Exit codes: 0 done · 1 refused (production guard) or any DB error.
import postgres from 'postgres';
import { isProduction } from '../src/lib/env.ts';
import {
  INTEREST_IDS,
  MAX_INTERESTS,
  MAX_KEYWORDS,
  interestOrder,
  isInterestId,
  normalizeInterest,
  normalizeKeyword,
} from '../src/domain/taxonomy.ts';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const ALLOW_PRODUCTION = args.has('--allow-production');

const databaseUrl =
  process.env.DATABASE_URL || process.env.INTEGRATION_DATABASE_URL || 'postgres://localhost:5432/welcome_dev';
const appEnv = process.env.APP_ENV || 'development';

/** host:port/dbname only — credentials never reach the terminal. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '(unparsable DATABASE_URL)';
  }
}

if (isProduction() && !ALLOW_PRODUCTION) {
  console.error('REFUSED: APP_ENV=production requires --allow-production (run --dry-run first)');
  process.exit(1);
}

interface TagRow {
  id: string;
  interests: string[];
  keywords: string[];
  offer_tags: string[];
  need_tags: string[];
}

type Pair = [raw: string, canonical: string];

interface RowPlan {
  id: string;
  interests: string[];
  keywords: string[];
  changed: boolean;
  /** Distinct raw tag → interest id pairs this row contributed. */
  mappings: Pair[];
  /** Distinct raw tag → keyword pairs this row contributed. */
  demotions: Pair[];
  interestOverflow: number;
  keywordOverflow: number;
  emptyTags: number;
  invalidExistingInterests: number;
}

function dedupe(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (!out.includes(value)) out.push(value);
  return out;
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** One row: legacy tags in, the exact v3 arrays that should be stored out. */
function planRow(row: TagRow): RowPlan {
  const mappings: Pair[] = [];
  const demotions: Pair[] = [];
  const mapped: string[] = [];
  const demoted: string[] = [];
  const seen = new Set<string>();
  let emptyTags = 0;

  for (const tag of [...row.offer_tags, ...row.need_tags]) {
    if (seen.has(tag)) continue;
    seen.add(tag);

    const interest = normalizeInterest(tag);
    if (interest) {
      if (!mapped.includes(interest)) mapped.push(interest);
      mappings.push([tag, interest]);
      continue;
    }
    const keyword = normalizeKeyword(tag);
    if (!keyword) {
      emptyTags += 1;
      continue;
    }
    if (!demoted.includes(keyword)) demoted.push(keyword);
    demotions.push([tag, keyword]);
  }

  // Catalogue order keeps the output stable no matter how the tags were ordered.
  mapped.sort((a, b) => interestOrder(a) - interestOrder(b));

  // Existing v3 values come FIRST and cap the list: this pass only ADDS what the
  // tags imply, so a user who already curated their v3 profile keeps it intact.
  const existingInterests = row.interests.filter((id) => isInterestId(id));
  const mergedInterests = dedupe([...existingInterests, ...mapped]);
  const interests = mergedInterests.slice(0, MAX_INTERESTS);

  const mergedKeywords = dedupe([...row.keywords, ...demoted]);
  const keywords = mergedKeywords.slice(0, MAX_KEYWORDS);

  return {
    id: row.id,
    interests,
    keywords,
    changed: !sameArray(row.interests, interests) || !sameArray(row.keywords, keywords),
    mappings,
    demotions,
    interestOverflow: mergedInterests.length - interests.length,
    keywordOverflow: mergedKeywords.length - keywords.length,
    emptyTags,
    invalidExistingInterests: row.interests.length - existingInterests.length,
  };
}

interface TableReport {
  table: string;
  scanned: number;
  changed: number;
  written: number;
  interestOverflow: number;
  keywordOverflow: number;
  emptyTags: number;
  invalidExistingInterests: number;
  mappingCounts: Map<string, number>;
  demotionCounts: Map<string, number>;
}

function tally(report: TableReport, plan: RowPlan): void {
  report.scanned += 1;
  report.invalidExistingInterests += plan.invalidExistingInterests;
  if (!plan.changed) return;
  report.changed += 1;
  report.interestOverflow += plan.interestOverflow;
  report.keywordOverflow += plan.keywordOverflow;
  report.emptyTags += plan.emptyTags;
  for (const [tag, interest] of plan.mappings) bump(report.mappingCounts, `${tag} → ${interest}`);
  for (const [tag, keyword] of plan.demotions) bump(report.demotionCounts, `${tag} → ${keyword}`);
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function mergeCounts(target: Map<string, number>, source: Map<string, number>): void {
  for (const [key, count] of source) target.set(key, (target.get(key) ?? 0) + count);
}

function sumCounts(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}

function topEntries(counts: Map<string, number>, limit: number): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

function emptyReport(table: string): TableReport {
  return {
    table,
    scanned: 0,
    changed: 0,
    written: 0,
    interestOverflow: 0,
    keywordOverflow: 0,
    emptyTags: 0,
    invalidExistingInterests: 0,
    mappingCounts: new Map(),
    demotionCounts: new Map(),
  };
}

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

async function migrateTable(table: 'profiles' | 'event_memberships'): Promise<TableReport> {
  const report = emptyReport(table);
  const rows = await sql<TagRow[]>`
    SELECT id, interests, keywords, offer_tags, need_tags FROM ${sql(table)} ORDER BY id
  `;

  if (DRY_RUN) {
    for (const row of rows) tally(report, planRow(row));
    return report;
  }

  // One transaction per table: the whole table is backfilled, or none of it.
  await sql.begin(async (tx) => {
    for (const row of rows) {
      const plan = planRow(row);
      tally(report, plan);
      if (!plan.changed) continue;
      if (table === 'profiles') {
        await tx`
          UPDATE profiles SET interests = ${plan.interests}, keywords = ${plan.keywords} WHERE id = ${plan.id}
        `;
      } else {
        await tx`
          UPDATE event_memberships SET interests = ${plan.interests}, keywords = ${plan.keywords} WHERE id = ${plan.id}
        `;
      }
      report.written += 1;
    }
  });
  return report;
}

function printReport(reports: TableReport[], totals: { tags: number; offer: number; need: number }): void {
  const line = '─'.repeat(66);
  console.log('');
  console.log(`[migrate-tags-to-v3] mode: ${DRY_RUN ? 'DRY RUN — no writes' : 'WRITE'}`);
  console.log(`[migrate-tags-to-v3] target: ${describeTarget(databaseUrl)} · APP_ENV=${appEnv}`);
  console.log(
    `[migrate-tags-to-v3] catalogue: ${INTEREST_IDS.length} interests · caps ${MAX_INTERESTS} interests / ${MAX_KEYWORDS} keywords per row`,
  );
  console.log(line);
  console.log('table              rows  changed  written  int-cap  kw-cap  empty-tags');
  for (const r of reports) {
    console.log(
      [
        r.table.padEnd(18),
        String(r.scanned).padStart(4),
        String(r.changed).padStart(8),
        String(r.written).padStart(8),
        String(r.interestOverflow).padStart(8),
        String(r.keywordOverflow).padStart(7),
        String(r.emptyTags).padStart(11),
      ].join(' '),
    );
  }
  console.log(line);
  console.log(
    `legacy tags read: ${totals.tags} (offer_tags ${totals.offer} / need_tags ${totals.need}) — columns left untouched`,
  );

  const mappingCounts = new Map<string, number>();
  const demotionCounts = new Map<string, number>();
  for (const r of reports) {
    mergeCounts(mappingCounts, r.mappingCounts);
    mergeCounts(demotionCounts, r.demotionCounts);
  }
  console.log(
    `mapped to interests: ${sumCounts(mappingCounts)} occurrences · ${mappingCounts.size} distinct tag→interest`,
  );
  console.log(`kept as keywords:    ${sumCounts(demotionCounts)} occurrences · ${demotionCounts.size} distinct tags`);

  const droppedInvalid = reports.reduce((acc, r) => acc + r.invalidExistingInterests, 0);
  if (droppedInvalid > 0) {
    console.warn(`[warn] ${droppedInvalid} pre-existing non-catalogue interest id(s) were not carried over`);
  }
  console.log(line);

  console.log('top tag → interest mappings:');
  for (const [label, count] of topEntries(mappingCounts, 12)) console.log(`  ${String(count).padStart(3)}  ${label}`);
  console.log('top tags demoted to keywords:');
  for (const [label, count] of topEntries(demotionCounts, 12)) console.log(`  ${String(count).padStart(3)}  ${label}`);
  console.log(line);
  console.log(
    DRY_RUN
      ? '[migrate-tags-to-v3] dry run complete — re-run without --dry-run to apply'
      : '[migrate-tags-to-v3] done',
  );
  console.log('');
}

try {
  const counts = await sql<{ offer: number; need: number }[]>`
    SELECT COALESCE(SUM(cardinality(offer_tags)), 0)::int AS offer,
           COALESCE(SUM(cardinality(need_tags)), 0)::int AS need
    FROM profiles
    UNION ALL
    SELECT COALESCE(SUM(cardinality(offer_tags)), 0)::int,
           COALESCE(SUM(cardinality(need_tags)), 0)::int
    FROM event_memberships
  `;
  const offer = counts.reduce((acc, row) => acc + Number(row.offer), 0);
  const need = counts.reduce((acc, row) => acc + Number(row.need), 0);

  const reports = [await migrateTable('profiles'), await migrateTable('event_memberships')];
  printReport(reports, { tags: offer + need, offer, need });
  process.exit(0);
} catch (err) {
  console.error('[migrate-tags-to-v3] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}

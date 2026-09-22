#!/usr/bin/env node
/**
 * `pnpm demo:reset` — put the demo personas back into a state that can be
 * demonstrated again.
 *
 * THE PROBLEM IT SOLVES. The product keeps ONE introduction per pair per event
 * context (introductions has UNIQUE(context_key, profile_a, profile_b)) and an
 * event's intro cooldown keeps a pair that already has an introduction out of
 * recommendations. So a two-person walkthrough spends the demo pair: after it,
 * POST /api/introductions answers `already_existed=true` and there is no fresh
 * pending card for the second person to accept. The owner cannot show the
 * introduction flow twice.
 *
 * WHAT IT IS. A maintenance command that removes the ONE introduction row for a
 * named demo pair in a named demo event, plus that row's own consents (the
 * schema cascades them) and its own outbox notices. Nothing else. It is meant to
 * be boring and loud: every guard is a refusal with a reason, the plan is
 * printed before anything is removed, and `--dry-run` prints the same plan and
 * changes nothing.
 *
 * THE GUARDS, IN ORDER — all before any write, the first two before any
 * connection at all (see src/domain/demo-reset.ts):
 *   1. both addresses must be on the hard-coded allowlist of synthetic demo
 *      personas; a real address has no path through this command;
 *   2. if the target looks production-like (APP_ENV=production, a non-local
 *      database host, or an unreadable database URL) the run must be explicitly
 *      acknowledged with `--i-know-this-is-production`;
 *   3. HASH_PEPPER must be set (it is how an address is looked up at all);
 *   4. the accounts behind those addresses must be flagged is_demo, active, have
 *      a profile, and be active members of the named event.
 *
 * USAGE:
 *   pnpm demo:reset --dry-run [--event=<slug>] [--pair=<email>,<email>]
 *   pnpm demo:reset [--i-know-this-is-production] [--event=<slug>] [--pair=<email>,<email>]
 *
 * The database target is DATABASE_URL, or NEON_CONN_DIRECT for this
 * deployment's live database (both are read from the environment; the URL is
 * never printed). Defaults: the event `welcome-demo-meetup` and the pair the
 * two-person walkthrough spends (demo2 ↔ marta.demo).
 *
 * EXIT CODES: 0 = done (including "there was nothing to reset"); 2 = refused
 * before connecting; 3 = refused after connecting, before any write; 1 =
 * unexpected error.
 */
import postgres from 'postgres';
import {
  deltas,
  demoPersonaLabel,
  formatCounts,
  guardDemoReset,
  isNoOp,
  parseDemoResetArgs,
  PRODUCTION_ACK_FLAG,
  WHY_THIS_MUCH,
  type ResetCounts,
} from '../src/domain/demo-reset.ts';
import { applyReset, countResetRows, loadDemoTarget, selectResetIntroductions } from '../src/infra/demo-reset.ts';

function refuse(exitCode: number, message: string): never {
  console.error(`\n${message}\n`);
  process.exit(exitCode);
}

/** A guard that only the database can answer (is_demo, membership). Thrown, not
 *  exited, so the connection is closed by the finally below. */
class Refusal extends Error {
  constructor(message: string) {
    super(message);
  }
}

const parsed = parseDemoResetArgs(process.argv.slice(2));
if (!parsed.ok) refuse(2, `${parsed.message}\n\nUsage: pnpm demo:reset [--dry-run] [${PRODUCTION_ACK_FLAG}] [--event=<slug>] [--pair=<email>,<email>]`);
const args = parsed.value;

// The URL is read here and never echoed: a refusal says "not local", not where.
const databaseUrl = process.env.DATABASE_URL || process.env.NEON_CONN_DIRECT || 'postgres://localhost:5432/welcome_dev';
const guard = guardDemoReset({ args, appEnv: process.env.APP_ENV, databaseUrl });
if (!guard.ok) refuse(2, guard.message);

const pepper = process.env.HASH_PEPPER;
if (!pepper) {
  refuse(2, 'REFUSED: HASH_PEPPER is required — it is how an address is looked up (the raw address is never stored).');
}

const describe = (c: ResetCounts) => `${c.introductions}/${c.consents}/${c.notices}/${c.audit}/${c.attempts}`;

console.log('DEMO RESET — returns the demo personas to a demonstrable state');
console.log('==============================================================');
console.log(`target       ${guard.value.productionLike ? 'PRODUCTION-LIKE — acknowledged with ' + PRODUCTION_ACK_FLAG : 'local'}` +
  ` (APP_ENV=${process.env.APP_ENV ?? 'unset'})`);
console.log(`mode         ${args.dryRun ? 'DRY RUN — nothing will be written' : 'APPLY'}`);
console.log(`event        ${args.eventSlug}`);
console.log(`pair         ${args.pair.map((email) => `${demoPersonaLabel(email)} <${email}>`).join('  ↔  ')}`);
console.log(`scope        ONE event context × ONE canonical pair — introductions WHERE context_key = 'event:<event-id>'` +
  ' AND profile_a = <min> AND profile_b = <max>; their consents (FK cascade) and their own outbox notices.');
console.log('');

const sql = postgres(databaseUrl, { max: 1 });
let exitCode = 0;
try {
  const target = await loadDemoTarget(sql, { eventSlug: args.eventSlug, pair: args.pair, pepper });
  if (!target.ok) throw new Refusal(target.message);
  const { scope, accounts, introCooldownDays } = target.value;

  console.log(`event id     ${scope.eventId}`);
  console.log(`cooldown     ${introCooldownDays} days — an introduction in this context keeps the pair out of recommendations`);
  console.log(`profiles     ${scope.profileA} (${accounts[0]!.email})  ↔  ${scope.profileB} (${accounts[1]!.email})`);
  console.log(`accounts     both is_demo = true, active, with a profile, active members of this event`);
  console.log(`context key  ${scope.contextKey}`);
  console.log('');

  const rows = await selectResetIntroductions(sql, scope);
  const ids = rows.map((row) => row.id);
  // Both count calls use the SAME ids, so the report shows the counters that
  // move (the pair's introductions, their consents, their notices) AND the one
  // that deliberately does not (the audit rows, still findable after the run).
  const before = await countResetRows(sql, scope, ids);

  console.log('WILL REMOVE');
  if (rows.length === 0) {
    console.log('  nothing — this pair has no introduction in this event context (already demonstrable)');
  }
  for (const row of rows) {
    const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? 'unknown');
    console.log(`  introduction  ${row.id}  state=${row.state}  created=${created}`);
  }
  console.log(`  consents      ${before.scoped.consents} (ON DELETE CASCADE from the introductions above)`);
  console.log(`  notices       ${before.scoped.notices} (outbox jobs whose subject_id is one of those introductions)`);
  console.log(`  attempts      ${before.scoped.attempts} (delivery attempts of those notices — cascade)`);
  console.log(`  audit rows    0 — append-only; the ${before.scoped.audit} row(s) recording these actions are KEPT`);
  console.log('');
  console.log('COUNTS BEFORE  introductions/consents/notices/audit/attempts  scoped=%s  totals=%s',
    describe(before.scoped), describe(before.totals));
  console.log('');
  console.log(WHY_THIS_MUCH);
  console.log('');

  if (args.dryRun) {
    console.log('DRY RUN: nothing was removed. Re-run without --dry-run to apply exactly the plan above.');
  } else {
    if (ids.length === 0) {
      console.log('Nothing to remove: the pair is already demonstrable.');
    } else {
      const removed = await applyReset(sql, scope, ids);
      console.log(`REMOVED: ${removed.introductions} introduction(s), ${removed.notices} notice(s) (and everything the schema cascades).`);
    }

    const after = await countResetRows(sql, scope, ids);
    console.log('');
    console.log('COUNTS AFTER');
    for (const line of formatCounts('scoped (the named pair in this event context)', before.scoped, after.scoped)) console.log(line);
    for (const line of formatCounts('totals (whole table)', before.totals, after.totals)) console.log(line);

    const dScoped = deltas(before.scoped, after.scoped);
    const dTotals = deltas(before.totals, after.totals);
    const same = (a: number, b: number) => (a === b ? 'MATCH' : `MISMATCH (scoped ${a}, whole table ${b})`);
    console.log('');
    console.log('SCOPE CHECK  (scoped delta vs whole-table delta)');
    console.log(`  introductions   ${same(dScoped.introductions, dTotals.introductions)}`);
    console.log(`  consents        ${same(dScoped.consents, dTotals.consents)}`);
    console.log(`  notices         ${same(dScoped.notices, dTotals.notices)}`);
    console.log(`  audit rows      ${same(dScoped.audit, dTotals.audit)}`);
    console.log(`  attempts        ${same(dScoped.attempts, dTotals.attempts)}`);

    // The introductions table is the one this command erases from, so a
    // whole-table movement larger than the plan's is a hard failure. The other
    // counters are informational: the worker's own bookkeeping (a notice leaving
    // 'pending', the cleanup pass removing a terminal job) can move them
    // legitimately while this command is running.
    if (dTotals.introductions !== dScoped.introductions) {
      console.error(
        `\nSCOPE WARNING: the introductions table moved by ${dTotals.introductions} while the named scope accounts for ` +
        `${dScoped.introductions}. Something else deleted introductions during this run.`,
      );
      exitCode = 1;
    }
    if (isNoOp(dScoped) && isNoOp(dTotals)) {
      console.log('\nIDEMPOTENT: every delta is zero — this run changed nothing.');
    }
  }
} catch (error) {
  if (error instanceof Refusal) {
    console.error(`\n${error.message}\n`);
    exitCode = 3;
  } else {
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    exitCode = 1;
  }
} finally {
  await sql.end({ timeout: 5 });
}

process.exit(exitCode);

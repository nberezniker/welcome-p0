#!/usr/bin/env node
/**
 * `pnpm demo:reset` — put the demo personas back into a state that can be
 * demonstrated again.
 *
 * THE PROBLEMS IT SOLVES.
 *   1. THE SPENT PAIR. The product keeps ONE introduction per pair per event
 *      context (introductions has UNIQUE(context_key, profile_a, profile_b)) and
 *      an event's intro cooldown keeps a pair that already has an introduction
 *      out of recommendations. So a two-person walkthrough spends the demo pair:
 *      after it, POST /api/introductions answers `already_existed=true` and there
 *      is no fresh pending card for the second person to accept.
 *   2. THE SPENT JOIN. The walkthrough's join step needs a persona who is NOT in
 *      the event (both older demo personas are seeded members), and joining is
 *      one-way through the UI — so after a run, the persona who joined stays a
 *      member and the non-member state the step demonstrates is gone. That is
 *      what `--unjoin` returns.
 *
 * WHAT IT IS. A maintenance command with two parts, both boring and loud:
 *   · INTRODUCTIONS (always) — removes the ONE introduction row for a named demo
 *     pair in a named demo event, plus that row's own consents (the schema
 *     cascades them) and its own outbox notices;
 *   · MEMBERSHIP (`--unjoin=<email>`) — removes the named persona's
 *     event_memberships row for the named event, and nothing else (no table
 *     references event_memberships, so nothing cascades; see
 *     WHY_THIS_MUCH_MEMBERSHIP in src/domain/demo-reset.ts).
 * Every guard is a refusal with a reason, each part's plan is printed before
 * anything is removed, and `--dry-run` prints the same plans and changes
 * nothing.
 *
 * THE GUARDS, IN ORDER — all before any write, the first two before any
 * connection at all (see src/domain/demo-reset.ts):
 *   1. every address involved (the pair AND the `--unjoin` target) must be on
 *      the hard-coded allowlist of synthetic demo personas; a real address has
 *      no path through this command;
 *   2. if the target looks production-like (APP_ENV=production, a non-local
 *      database host, or an unreadable database URL) the run must be explicitly
 *      acknowledged with `--i-know-this-is-production`;
 *   3. HASH_PEPPER must be set (it is how an address is looked up at all);
 *   4. the accounts behind those addresses must be flagged is_demo, active and
 *      have a profile; and for the introductions part both must be active
 *      members of the named event — EXCEPT the run's own `--unjoin` target, whose
 *      membership this very run removes (the exemption is printed in the plan).
 *
 * USAGE:
 *   pnpm demo:reset --dry-run [--event=<slug>] [--pair=<email>,<email>] [--unjoin=<email>]
 *   pnpm demo:reset [--i-know-this-is-production] [--event=<slug>] [--pair=<email>,<email>] [--unjoin=<email>]
 *
 * The full restore of the live demo in one command (the pair the walkthrough
 * spends, and the persona it joins in):
 *   pnpm demo:reset --i-know-this-is-production --unjoin=lucia.demo@welcome.test
 *
 * The database target is DATABASE_URL, or NEON_CONN_DIRECT for this
 * deployment's live database (both are read from the environment; the URL is
 * never printed). Defaults: the event `welcome-demo-meetup` and the pair the
 * two-person walkthrough spends (demo2 ↔ lucia.demo).
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
  formatMembershipCounts,
  guardDemoReset,
  isMembershipNoOp,
  isNoOp,
  membershipDeltas,
  parseDemoResetArgs,
  PRODUCTION_ACK_FLAG,
  UNJOIN_FLAG,
  WHY_THIS_MUCH,
  WHY_THIS_MUCH_MEMBERSHIP,
  type ResetCounts,
} from '../src/domain/demo-reset.ts';
import {
  applyMembershipReset,
  applyReset,
  countMembershipRows,
  countResetRows,
  loadDemoTarget,
  loadMembershipTarget,
  selectResetIntroductions,
} from '../src/infra/demo-reset.ts';

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
if (!parsed.ok) {
  refuse(
    2,
    `${parsed.message}\n\nUsage: pnpm demo:reset [--dry-run] [${PRODUCTION_ACK_FLAG}] [--event=<slug>] [--pair=<email>,<email>] [${UNJOIN_FLAG}=<email>]`,
  );
}
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
console.log(`parts        introductions (the pair)${args.unjoin === null ? '' : ' + membership (' + UNJOIN_FLAG + ')'}`);
if (args.unjoin !== null) {
  console.log(`unjoin       ${demoPersonaLabel(args.unjoin)} <${args.unjoin}> — returned to the NON-MEMBER state`);
}
console.log(`scope        ONE event context × ONE canonical pair — introductions WHERE context_key = 'event:<event-id>'` +
  ' AND profile_a = <min> AND profile_b = <max>; their consents (FK cascade) and their own outbox notices.');
if (args.unjoin !== null) {
  console.log('             ONE event × ONE profile — event_memberships WHERE event_id = <event-id> AND profile_id = <profile-id>.');
}
console.log('');

const sql = postgres(databaseUrl, { max: 1 });
let exitCode = 0;
try {
  // ── PART 1 — the introductions (the spent pair) ───────────────────────────
  console.log('PART 1/2 — INTRODUCTIONS (the spent pair)');
  console.log('----------------------------------------');
  // The `--unjoin` target is exempt from the introductions part's membership
  // requirement: this same run removes that membership, so requiring it would
  // make the documented restore command work once and then refuse itself.
  const target = await loadDemoTarget(sql, {
    eventSlug: args.eventSlug,
    pair: args.pair,
    pepper,
    allowNonMember: args.unjoin === null ? [] : [args.unjoin],
  });
  if (!target.ok) {
    // The introductions part refusing on membership is not a reason to block the
    // membership part: the two touch different tables, and the operator asked
    // for both. Nothing is deleted under a refusal — this only skips the part.
    if (args.unjoin !== null && target.code === 'refused_not_a_member') {
      console.log(`SKIPPED (introductions): ${target.message}`);
      console.log(
        `  The membership part below still runs — it does not depend on either persona being a member. This is the ` +
          `normal state after a demo that has already been reset (nobody has joined yet); the introductions part ` +
          `becomes meaningful again once ${args.pair.join(' and ')} are both in the event.`,
      );
      console.log('');
    } else {
      throw new Refusal(target.message);
    }
  }

  if (target.ok) {
    const { scope, accounts, introCooldownDays } = target.value;

    console.log(`event id     ${scope.eventId}`);
    console.log(`cooldown     ${introCooldownDays} days — an introduction in this context keeps the pair out of recommendations`);
    console.log(`profiles     ${scope.profileA} (${accounts[0]!.email})  ↔  ${scope.profileB} (${accounts[1]!.email})`);
    console.log(`accounts     both is_demo = true, active, with a profile, active members of this event`);
    console.log(`context key  ${scope.contextKey}`);
    if (args.unjoin !== null && args.pair.includes(args.unjoin)) {
      console.log(
        `waiver       ${args.unjoin} is NOT required to be an active member: this run removes that membership ` +
          `(${UNJOIN_FLAG}), so requiring it would block the restore it exists for`,
      );
    }
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
  }

  // ── PART 2 — the membership (the spent join) ──────────────────────────────
  if (args.unjoin !== null) {
    console.log('');
    console.log('PART 2/2 — MEMBERSHIP (the spent join)');
    console.log('-------------------------------------');
    const membershipTarget = await loadMembershipTarget(sql, {
      eventSlug: args.eventSlug,
      email: args.unjoin,
      pepper,
    });
    if (!membershipTarget.ok) throw new Refusal(membershipTarget.message);
    const { scope, membership } = membershipTarget.value;

    console.log(`event id     ${scope.eventId} (${scope.eventSlug})`);
    console.log(`persona      ${demoPersonaLabel(scope.email)} <${scope.email}>`);
    console.log(`profile      ${scope.profileId}`);
    console.log(`account      is_demo = true, active, with a profile (the same gate the introductions part applies)`);
    console.log(`state        ${membership ? 'an event_memberships row is present' : 'ALREADY a non-member of this event'}`);
    console.log('');

    const before = await countMembershipRows(sql, scope);
    console.log('WILL REMOVE');
    if (!membership) {
      console.log('  nothing — this persona already has no membership in this event (the non-member state is already true)');
    } else {
      const created = membership.created_at instanceof Date ? membership.created_at.toISOString() : String(membership.created_at);
      console.log(
        `  membership    ${membership.id}  state=${membership.state}  directory_visible=${membership.directory_visible}` +
          `  matching_enabled=${membership.matching_enabled}  attendance=${membership.attendance_source}  created=${created}`,
      );
    }
    console.log('  cascade       none — no table references event_memberships (its own columns go with the row)');
    console.log('  untouched     introductions, consents, blocks, notes and audit rows that mention this persona');
    console.log('');
    console.log('COUNTS BEFORE  event memberships  scoped=%d  totals=%d', before.scoped.memberships, before.totals.memberships);
    console.log('');
    console.log(WHY_THIS_MUCH_MEMBERSHIP);
    console.log('');

    if (args.dryRun) {
      console.log('DRY RUN: nothing was removed. Re-run without --dry-run to apply exactly the plan above.');
    } else {
      if (!membership) {
        console.log('Nothing to remove: the persona is already outside this event.');
      } else {
        const removed = await applyMembershipReset(sql, scope);
        console.log(`REMOVED: ${removed.length} membership row(s), and nothing else.`);
      }

      const after = await countMembershipRows(sql, scope);
      console.log('');
      console.log('COUNTS AFTER');
      for (const line of formatMembershipCounts('scoped (the named persona in the named event)', before.scoped, after.scoped)) {
        console.log(line);
      }
      for (const line of formatMembershipCounts('totals (whole table)', before.totals, after.totals)) console.log(line);

      const dScoped = membershipDeltas(before.scoped, after.scoped);
      const dTotals = membershipDeltas(before.totals, after.totals);
      console.log('');
      console.log('SCOPE CHECK  (scoped delta vs whole-table delta)');
      console.log(
        `  memberships     ${dScoped.memberships === dTotals.memberships ? 'MATCH' : `MISMATCH (scoped ${dScoped.memberships}, whole table ${dTotals.memberships})`}` +
          ' — a whole-table movement larger than this run\'s means somebody else joined or left mid-run',
      );
      if (dTotals.memberships !== dScoped.memberships) {
        console.error(
          `\nSCOPE WARNING: the event_memberships table moved by ${dTotals.memberships} while the named persona accounts for ` +
            `${dScoped.memberships}. Something else changed memberships during this run.`,
        );
        exitCode = 1;
      }
      if (isMembershipNoOp(dScoped) && isMembershipNoOp(dTotals)) {
        console.log('\nIDEMPOTENT: every delta is zero — this run changed nothing.');
      }
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

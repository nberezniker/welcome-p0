import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DEMO_EVENT_SLUG,
  DEFAULT_DEMO_PAIR,
  DEMO_EMAIL_ALLOWLIST,
  PRODUCTION_ACK_FLAG,
  WHY_THIS_MUCH,
  WHY_THIS_MUCH_MEMBERSHIP,
  deltas,
  demoPersonaLabel,
  demoResetScope,
  formatCounts,
  formatMembershipCounts,
  guardDemoReset,
  isMembershipNoOp,
  isNoOp,
  looksProductionLike,
  membershipDeltas,
  membershipResetScope,
  parseDemoResetArgs,
  qualifyDemoAccounts,
  qualifyMembershipPersona,
  selectIntroductionsToReset,
  type DemoAccountRow,
  type DemoResetArgs,
  type IntroductionRow,
  type ResetCounts,
} from '../../src/domain/demo-reset';

/**
 * The guards and the selection of `pnpm demo:reset`, pinned WITHOUT a database.
 *
 * This command can erase a relationship, so the tests that matter are the ones
 * that prove it says NO: a real address, an unacknowledged production target, an
 * account that is not flagged demo, a pair that is not active members, a row
 * that belongs to another pair or another event. The happy path is one test;
 * the refusals are the rest.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function args(overrides: Partial<DemoResetArgs> = {}): DemoResetArgs {
  return {
    dryRun: false,
    acknowledged: false,
    eventSlug: DEFAULT_DEMO_EVENT_SLUG,
    pair: DEFAULT_DEMO_PAIR,
    unjoin: null,
    ...overrides,
  };
}

const LOCAL_DB = 'postgres://welcome:welcome@localhost:5432/welcome_dev';
const JOINER = 'lucia.demo@welcome.test';

// ---------------------------------------------------------------------------
// The allowlist is the one thing that cannot be configured away
// ---------------------------------------------------------------------------

test('demo reset: the allowlist holds only synthetic *.test personas', () => {
  assert.deepEqual([...DEMO_EMAIL_ALLOWLIST], [
    'demo1@welcome.test',
    'demo2@welcome.test',
    'marta.demo@welcome.test',
    // The NON-MEMBER persona (scripts/seed-demo-event.mts): the one the live join
    // step is demonstrated with, and the reason the membership part exists. The
    // allowlist grew by exactly this address and nothing else changed.
    'lucia.demo@welcome.test',
  ]);
  for (const email of DEMO_EMAIL_ALLOWLIST) {
    assert.match(email, /@welcome\.test$/, 'every allowlisted address must be a synthetic test address');
  }
  // The plan names the persona, so the operator sees WHO is about to be erased.
  assert.equal(demoPersonaLabel('demo2@welcome.test'), 'Дмитрий Ковалёв');
  assert.equal(demoPersonaLabel('marta.demo@welcome.test'), 'Marta Ruiz');
  assert.equal(demoPersonaLabel('lucia.demo@welcome.test'), 'Lucía Ferrer');
  assert.equal(demoPersonaLabel('someone@example.com'), 'unknown persona');
  // The pair the walkthrough spends must be exactly the pair this command
  // defaults to, and the event it spends it in must be the default event:
  // otherwise the reset would "succeed" and leave the demo unusable.
  assert.deepEqual([...DEFAULT_DEMO_PAIR], ['demo2@welcome.test', 'lucia.demo@welcome.test']);
  assert.equal(DEFAULT_DEMO_EVENT_SLUG, 'welcome-demo-meetup');
});

test('demo reset: the walkthrough it exists for still spends that exact pair', () => {
  const source = readFileSync(path.join(ROOT, 'scripts', 'two-user-walkthrough.mjs'), 'utf8');
  const email = (name: string) => source.match(new RegExp(`const ${name} = '([^']+)'`))?.[1];
  const slug = source.match(/const EVENT_SLUG = '([^']+)'/)?.[1];
  assert.equal(email('A_EMAIL'), DEFAULT_DEMO_PAIR[0], 'walkthrough persona A moved — update DEFAULT_DEMO_PAIR');
  assert.equal(email('B_EMAIL'), DEFAULT_DEMO_PAIR[1], 'walkthrough persona B moved — update DEFAULT_DEMO_PAIR');
  assert.equal(slug, DEFAULT_DEMO_EVENT_SLUG, 'walkthrough event moved — update DEFAULT_DEMO_EVENT_SLUG');
  // The pair's second persona is also the membership part's default target: the
  // ONE persona whose membership the walkthrough's join step spends.
  assert.equal(email('B_EMAIL'), 'lucia.demo@welcome.test', 'the walkthrough must join as the non-member persona');
  assert.equal(email('NON_MEMBER_EMAIL'), email('B_EMAIL'), 'the membership part and the walkthrough must name the same joiner');
});

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

test('demo reset: arguments default to the demo pair, the demo event and APPLY', () => {
  const parsed = parseDemoResetArgs([]);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.value, args());
});

test('demo reset: --dry-run and the acknowledgement flag are read, not assumed', () => {
  const parsed = parseDemoResetArgs(['--dry-run']);
  assert.equal(parsed.ok && parsed.value.dryRun, true);
  assert.equal(parsed.ok && parsed.value.acknowledged, false);

  const acked = parseDemoResetArgs([PRODUCTION_ACK_FLAG, '--event=other-demo', '--pair=demo1@welcome.test,demo2@welcome.test']);
  assert.equal(acked.ok, true);
  assert.deepEqual(acked.ok && acked.value.pair, ['demo1@welcome.test', 'demo2@welcome.test']);
  assert.equal(acked.ok && acked.value.eventSlug, 'other-demo');
});

test('demo reset: a flag it does not know is refused, never ignored', () => {
  for (const bad of [
    ['--dryrun'],
    ['--force'],
    ['--pair'], // a bare value flag must not fall back to the default pair
    ['--event'],
    ['--event='],
    ['--unjoin'],
    ['--unjoin='],
    ['--unjoin=   '],
    ['--dry-run=yes'], // …nor may a boolean flag quietly carry a value
    ['extra'],
    ['--pair=demo2@welcome.test'],
  ]) {
    const parsed = parseDemoResetArgs(bad);
    assert.equal(parsed.ok, false, `${bad.join(' ')} must be refused`);
  }
});

// ---------------------------------------------------------------------------
// The membership part (--unjoin)
// ---------------------------------------------------------------------------

test('demo reset: the membership part is opt-in, and its address is read from the flag', () => {
  // Omitting it changes nothing about the introductions part: `unjoin` is null
  // and the run is exactly what it was before the flag existed.
  const bare = parseDemoResetArgs([]);
  assert.equal(bare.ok, true);
  assert.equal(bare.ok && bare.value.unjoin, null);
  const dry = parseDemoResetArgs(['--dry-run']);
  assert.equal(dry.ok && dry.value.unjoin, null);

  const parsed = parseDemoResetArgs([`--unjoin=${JOINER}`, '--dry-run']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.value.unjoin, JOINER);
  assert.equal(parsed.ok && parsed.value.dryRun, true);
  // The pair is untouched by the flag: it keeps its own default.
  assert.deepEqual(parsed.ok && parsed.value.pair, DEFAULT_DEMO_PAIR);
});

test('demo reset: the membership part names an address, and that address is checked like the pair', () => {
  // A real address has no path through the membership part either — the same
  // refusal the pair gets, because the guard reads every named address together.
  for (const acknowledged of [false, true]) {
    const verdict = guardDemoReset({
      args: args({ unjoin: 'real.person@gmail.com', acknowledged }),
      appEnv: 'development',
      databaseUrl: LOCAL_DB,
    });
    assert.equal(verdict.ok, false, `a real address must be refused (ack=${acknowledged})`);
    assert.equal(verdict.ok === false && verdict.code, 'refused_not_allowlisted');
  }

  // An allowlisted one passes the pre-connection gate…
  assert.equal(
    guardDemoReset({ args: args({ unjoin: JOINER }), appEnv: 'development', databaseUrl: LOCAL_DB }).ok,
    true,
  );
  // …and the production acknowledgement is still required for it.
  const unacknowledged = guardDemoReset({
    args: args({ unjoin: JOINER }),
    appEnv: 'production',
    databaseUrl: 'postgres://u:p@db.example.com:5432/welcome',
  });
  assert.equal(unacknowledged.ok === false && unacknowledged.code, 'refused_production_not_acknowledged');
});

test('demo reset: the membership part qualifies a persona by its ACCOUNT, never by its membership', () => {
  // The same account-level gate as the pair (exists / is_demo / active /
  // profile), because "the rows belong to synthetic personas" is what makes
  // this command allowed to delete at all.
  const row = accountRow({ email: JOINER });
  assert.equal(qualifyMembershipPersona([row], JOINER).ok, true);

  for (const [override, code] of [
    [{ is_demo: false }, 'refused_not_demo'],
    [{ account_status: 'suspended' }, 'refused_account_inactive'],
    [{ profile_id: null }, 'refused_no_profile'],
    [{ account_id: null }, 'refused_account_missing'],
  ] as const) {
    const verdict = qualifyMembershipPersona([{ ...row, ...override }], JOINER);
    assert.equal(verdict.ok === false && verdict.code, code, `${JSON.stringify(override)} must be refused`);
  }

  // A persona the database does not know at all is refused too.
  assert.equal(qualifyMembershipPersona([], JOINER).ok === false, true);
});

test('demo reset: the membership part reports a persona who is already outside the event as a no-op', () => {
  // Being outside the event is the STATE this part produces, so it cannot be a
  // refusal: a second run of the same command has to be an honest no-op, and a
  // refusal there would make the documented restore command un-repeatable.
  const before = { memberships: 0 };
  const after = { memberships: 0 };
  assert.equal(isMembershipNoOp(membershipDeltas(before, after)), true);
  assert.deepEqual(membershipDeltas({ memberships: 1 }, { memberships: 0 }), { memberships: -1 });
  assert.equal(isMembershipNoOp(membershipDeltas({ memberships: 1 }, { memberships: 0 })), false);
  // The report names the counter and the movement, like the introductions part.
  const lines = formatMembershipCounts('scoped', { memberships: 1 }, { memberships: 0 });
  assert.equal(lines.length, 2);
  assert.match(lines.join('\n'), /event memberships {2}1 → 0 {2}\(-1\)/);
});

test('demo reset: the membership plan explains why the row itself must go, and what does not follow it', () => {
  // The same rule the introductions part holds its own plan to: "and nothing
  // more" is only meaningful if the floor is named where the operator reads it.
  assert.match(WHY_THIS_MUCH_MEMBERSHIP, /no table has a foreign key to event_memberships/);
  assert.match(WHY_THIS_MUCH_MEMBERSHIP, /event\.joined audit row stays/i);
  assert.match(WHY_THIS_MUCH_MEMBERSHIP, /non-member state/);
  assert.notEqual(WHY_THIS_MUCH_MEMBERSHIP, WHY_THIS_MUCH, 'the two parts must not share one explanation');
});

test('demo reset: the membership scope is one event × one profile, joined by both', () => {
  const scope = membershipResetScope({ id: 'event-1', slug: 'welcome-demo-meetup' }, 'profile-1', JOINER);
  assert.deepEqual(scope, {
    eventId: 'event-1',
    eventSlug: 'welcome-demo-meetup',
    profileId: 'profile-1',
    email: JOINER,
  });
  // The statement that deletes must be scoped by both columns: a scope carrying
  // only one of them would let the delete reach another persona's membership in
  // this event, or this persona's membership in another event.
  const source = readFileSync(path.join(ROOT, 'src', 'infra', 'demo-reset.ts'), 'utf8');
  assert.ok(
    /DELETE FROM event_memberships\s+WHERE event_id = \$\{scope\.eventId\} AND profile_id = \$\{scope\.profileId\}/.test(source),
    'applyMembershipReset must carry both scope columns in its WHERE clause',
  );
});

// ---------------------------------------------------------------------------
// Production-likeness — fails CLOSED
// ---------------------------------------------------------------------------

test('demo reset: only a plainly local database is treated as non-production', () => {
  assert.equal(looksProductionLike({ appEnv: 'development', databaseUrl: LOCAL_DB }), false);
  assert.equal(looksProductionLike({ appEnv: 'test', databaseUrl: 'postgres://u:p@127.0.0.1:5432/welcome_test' }), false);
  assert.equal(looksProductionLike({ appEnv: 'development', databaseUrl: 'postgres://u:p@[::1]:5432/x' }), false);
  // APP_ENV alone is enough, whatever the host says.
  assert.equal(looksProductionLike({ appEnv: 'production', databaseUrl: LOCAL_DB }), true);
  // …and so is a remote host, whatever APP_ENV says.
  assert.equal(looksProductionLike({ appEnv: 'development', databaseUrl: 'postgres://u:p@db.example.com:5432/x' }), true);
  // Unknown target: not something this tool will call local.
  assert.equal(looksProductionLike({ appEnv: 'development', databaseUrl: 'not a url' }), true);
  assert.equal(looksProductionLike({ appEnv: undefined, databaseUrl: undefined }), true);
  assert.equal(looksProductionLike({ appEnv: 'development', databaseUrl: '' }), true);
});

test('demo reset: a production-like target is refused until it is acknowledged', () => {
  const productionLike = { appEnv: 'production', databaseUrl: 'postgres://u:p@db.example.com:5432/welcome' };
  const refused = guardDemoReset({ args: args(), ...productionLike });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, 'refused_production_not_acknowledged');
  assert.match(refused.ok === false ? refused.message : '', /--i-know-this-is-production/);

  assert.equal(guardDemoReset({ args: args({ acknowledged: true }), ...productionLike }).ok, true);
  // A local target needs no acknowledgement.
  assert.equal(guardDemoReset({ args: args(), appEnv: 'development', databaseUrl: LOCAL_DB }).ok, true);
});

test('demo reset: an address off the allowlist can never be reset, with or without the flag', () => {
  for (const pair of [
    ['nikita@example.com', 'demo2@welcome.test'],
    ['demo2@welcome.test', 'real.person@gmail.com'],
    ['demo2@welcome.test', 'demo2@welcome.test'],
  ] satisfies [string, string][]) {
    for (const acknowledged of [false, true]) {
      const verdict = guardDemoReset({ args: args({ pair, acknowledged }), appEnv: 'production', databaseUrl: LOCAL_DB });
      assert.equal(verdict.ok, false, `${pair.join(',')} (ack=${acknowledged}) must be refused`);
    }
  }
  const offList = guardDemoReset({ args: args({ pair: ['nikita@example.com', 'demo2@welcome.test'] }), appEnv: 'development', databaseUrl: LOCAL_DB });
  assert.equal(offList.ok === false && offList.code, 'refused_not_allowlisted');
});

test('demo reset: no database target is refused before anything could connect', () => {
  const verdict = guardDemoReset({ args: args(), appEnv: 'development', databaseUrl: undefined });
  assert.equal(verdict.ok === false && verdict.code, 'refused_no_database_url');
});

// ---------------------------------------------------------------------------
// Which accounts qualify
// ---------------------------------------------------------------------------

function accountRow(overrides: Partial<DemoAccountRow> & { email: string }): DemoAccountRow {
  return {
    account_id: `acct-${overrides.email}`,
    is_demo: true,
    account_status: 'active',
    profile_id: `profile-${overrides.email}`,
    ...overrides,
  };
}

test('demo reset: two distinct demo accounts with profiles qualify', () => {
  const rows = DEFAULT_DEMO_PAIR.map((email) => accountRow({ email }));
  const qualified = qualifyDemoAccounts(rows, DEFAULT_DEMO_PAIR);
  assert.equal(qualified.ok, true);
  assert.notEqual(qualified.ok && qualified.value.profileA, qualified.ok && qualified.value.profileB);
  assert.equal(qualified.ok && qualified.value.byEmail.get(DEFAULT_DEMO_PAIR[0])?.profileId, `profile-${DEFAULT_DEMO_PAIR[0]}`);
});

test('demo reset: the is_demo flag is READ, and a real account is refused', () => {
  const rows = DEFAULT_DEMO_PAIR.map((email) => accountRow({ email }));
  const notDemo = qualifyDemoAccounts(
    [rows[0]!, { ...rows[1]!, is_demo: false }],
    DEFAULT_DEMO_PAIR,
  );
  assert.equal(notDemo.ok, false);
  assert.equal(notDemo.ok === false && notDemo.code, 'refused_not_demo');

  // A missing row (address not seeded here), a disabled account, a profile-less
  // account and the same profile twice are all refusals too.
  assert.equal(qualifyDemoAccounts([rows[0]!], DEFAULT_DEMO_PAIR).ok, false);
  assert.equal(qualifyDemoAccounts([rows[0]!, { ...rows[1]!, account_status: 'disabled' }], DEFAULT_DEMO_PAIR).ok === false, true);
  assert.equal(qualifyDemoAccounts([rows[0]!, { ...rows[1]!, profile_id: null }], DEFAULT_DEMO_PAIR).ok, false);
  assert.equal(
    qualifyDemoAccounts([rows[0]!, { ...rows[1]!, profile_id: rows[0]!.profile_id }], DEFAULT_DEMO_PAIR).ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// Which rows qualify
// ---------------------------------------------------------------------------

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const PROFILE_LOW = 'aaaaaaaa-0000-4000-8000-000000000000';
const PROFILE_HIGH = 'bbbbbbbb-0000-4000-8000-000000000000';
const OTHER_PROFILE = 'cccccccc-0000-4000-8000-000000000000';

function scope() {
  return demoResetScope({ id: EVENT_ID, slug: DEFAULT_DEMO_EVENT_SLUG }, [PROFILE_LOW, PROFILE_HIGH]);
}

function intro(overrides: Partial<IntroductionRow> = {}): IntroductionRow {
  return {
    id: 'intro-1',
    event_id: EVENT_ID,
    context_key: `event:${EVENT_ID}`,
    profile_a: PROFILE_LOW,
    profile_b: PROFILE_HIGH,
    state: 'mutual',
    ...overrides,
  };
}

test('demo reset: the scope is the canonical pair in the event context', () => {
  const s = scope();
  assert.equal(s.contextKey, `event:${EVENT_ID}`);
  assert.equal(s.profileA < s.profileB, true, 'the pair must be canonical, min first');
  // Naming the same two people in the other order yields the same scope.
  assert.deepEqual(demoResetScope({ id: EVENT_ID, slug: DEFAULT_DEMO_EVENT_SLUG }, [PROFILE_HIGH, PROFILE_LOW]), s);
});

test('demo reset: only the named pair in the named event context is selected', () => {
  const s = scope();
  const mine = intro();
  const rows: IntroductionRow[] = [
    mine,
    intro({ id: 'other-event', context_key: 'event:22222222-2222-4222-8222-222222222222' }),
    intro({ id: 'other-pair', profile_b: OTHER_PROFILE }),
    intro({ id: 'other-pair-reversed', profile_a: OTHER_PROFILE }),
    intro({ id: 'personal', context_key: `personal:${PROFILE_LOW}` }),
    intro({ id: 'no-event', context_key: 'event:33333333-3333-4333-8333-333333333333', event_id: null }),
  ];
  assert.deepEqual(selectIntroductionsToReset(rows, s).map((r) => r.id), ['intro-1']);
});

test('demo reset: a pair the scope does not name selects nothing at all', () => {
  const s = scope();
  const rows = [intro(), intro({ id: 'x', profile_b: OTHER_PROFILE })];
  assert.deepEqual(selectIntroductionsToReset(rows, { ...s, profileB: OTHER_PROFILE }), rows.slice(1));
  assert.deepEqual(selectIntroductionsToReset(rows, { ...s, contextKey: `personal:${PROFILE_LOW}` }), []);
});

// ---------------------------------------------------------------------------
// The idempotency arithmetic the report is built on
// ---------------------------------------------------------------------------

const ZERO: ResetCounts = { introductions: 0, consents: 0, notices: 0, audit: 0, attempts: 0 };

test('demo reset: a second run is a no-op by arithmetic, not by hope', () => {
  const before: ResetCounts = { introductions: 1, consents: 2, notices: 2, audit: 3, attempts: 1 };
  const after: ResetCounts = { introductions: 0, consents: 0, notices: 0, audit: 3, attempts: 0 };
  const d = deltas(before, after);
  assert.deepEqual(d, { introductions: -1, consents: -2, notices: -2, audit: 0, attempts: -1 });
  assert.equal(isNoOp(d), false);
  // The audit counter is the one that must NOT move: append-only, kept.
  assert.equal(d.audit, 0);

  assert.deepEqual(deltas(after, after), ZERO);
  assert.equal(isNoOp(deltas(after, after)), true);
});

test('demo reset: the report prints before → after and the delta for every counter', () => {
  const before: ResetCounts = { introductions: 1, consents: 2, notices: 3, audit: 4, attempts: 5 };
  const after: ResetCounts = { introductions: 0, consents: 0, notices: 0, audit: 4, attempts: 0 };
  const lines = formatCounts('scoped (the named pair)', before, after);
  assert.equal(lines[0], '  scoped (the named pair)');
  assert.equal(lines.length, 6, 'one label + the five counters');
  const expected = [
    'introductions      1 → 0  (-1)',
    'consents           2 → 0  (-2)',
    'notices            3 → 0  (-3)',
    'audit rows         4 → 4  (0)',
    'delivery attempts  5 → 0  (-5, cascade of the notices)',
  ];
  for (const [i, want] of expected.entries()) {
    assert.equal(lines[i + 1]?.trim(), want, `counter line ${i + 1}`);
  }
});

test('demo reset: the plan explains why the introduction row itself must go', () => {
  assert.match(WHY_THIS_MUCH, /UNIQUE\(context_key, profile_a, profile_b\)/);
  assert.match(WHY_THIS_MUCH, /already_existed=true/);
  assert.match(WHY_THIS_MUCH, /cooldown/);
  assert.match(WHY_THIS_MUCH, /append-only/);
});

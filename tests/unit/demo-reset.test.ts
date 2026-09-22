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
  deltas,
  demoPersonaLabel,
  demoResetScope,
  formatCounts,
  guardDemoReset,
  isNoOp,
  looksProductionLike,
  parseDemoResetArgs,
  qualifyDemoAccounts,
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
    ...overrides,
  };
}

const LOCAL_DB = 'postgres://welcome:welcome@localhost:5432/welcome_dev';

// ---------------------------------------------------------------------------
// The allowlist is the one thing that cannot be configured away
// ---------------------------------------------------------------------------

test('demo reset: the allowlist holds only synthetic *.test personas', () => {
  assert.deepEqual([...DEMO_EMAIL_ALLOWLIST], ['demo1@welcome.test', 'demo2@welcome.test', 'marta.demo@welcome.test']);
  for (const email of DEMO_EMAIL_ALLOWLIST) {
    assert.match(email, /@welcome\.test$/, 'every allowlisted address must be a synthetic test address');
  }
  // The plan names the persona, so the operator sees WHO is about to be erased.
  assert.equal(demoPersonaLabel('demo2@welcome.test'), 'Дмитрий Ковалёв');
  assert.equal(demoPersonaLabel('marta.demo@welcome.test'), 'Marta Ruiz');
  assert.equal(demoPersonaLabel('someone@example.com'), 'unknown persona');
  // The pair the walkthrough spends must be exactly the pair this command
  // defaults to, and the event it spends it in must be the default event:
  // otherwise the reset would "succeed" and leave the demo unusable.
  assert.deepEqual([...DEFAULT_DEMO_PAIR], ['demo2@welcome.test', 'marta.demo@welcome.test']);
  assert.equal(DEFAULT_DEMO_EVENT_SLUG, 'welcome-demo-meetup');
});

test('demo reset: the walkthrough it exists for still spends that exact pair', () => {
  const source = readFileSync(path.join(ROOT, 'scripts', 'two-user-walkthrough.mjs'), 'utf8');
  const email = (name: string) => source.match(new RegExp(`const ${name} = '([^']+)'`))?.[1];
  const slug = source.match(/const EVENT_SLUG = '([^']+)'/)?.[1];
  assert.equal(email('A_EMAIL'), DEFAULT_DEMO_PAIR[0], 'walkthrough persona A moved — update DEFAULT_DEMO_PAIR');
  assert.equal(email('B_EMAIL'), DEFAULT_DEMO_PAIR[1], 'walkthrough persona B moved — update DEFAULT_DEMO_PAIR');
  assert.equal(slug, DEFAULT_DEMO_EVENT_SLUG, 'walkthrough event moved — update DEFAULT_DEMO_EVENT_SLUG');
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
    ['--dry-run=yes'], // …nor may a boolean flag quietly carry a value
    ['extra'],
    ['--pair=demo2@welcome.test'],
  ]) {
    const parsed = parseDemoResetArgs(bad);
    assert.equal(parsed.ok, false, `${bad.join(' ')} must be refused`);
  }
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

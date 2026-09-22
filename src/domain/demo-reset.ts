/**
 * Demo reset — the guards and the selection, as pure functions.
 *
 * WHY THIS EXISTS. The product keeps ONE introduction per pair per event
 * context, and an event's intro cooldown keeps a pair that already has an
 * introduction out of recommendations. So a two-person walkthrough can be shown
 * exactly ONCE per pair per event: after it, POST /api/introductions answers
 * `already_existed=true` and there is no fresh pending card to accept. This
 * module is what decides, without touching a database, whether a request to
 * return the demo personas to a demonstrable state may proceed — and which rows
 * exactly it may touch.
 *
 * TWO PARTS, EACH WITH ITS OWN GUARDS:
 *   1. the INTRODUCTION part (default): removes the one introduction row of a
 *      named pair in a named event context, plus its own consents and notices;
 *   2. the MEMBERSHIP part (`--unjoin=<email>`): removes the named persona's
 *      event_memberships row for the named event, so the event page offers the
 *      join affordance again. Nothing else — no table references
 *      event_memberships, so no cascade follows (see WHY_THIS_MUCH_MEMBERSHIP).
 * The two run in ONE invocation (introductions first: that part requires both
 * personas to be members, which is exactly the state `--unjoin` ends), and each
 * one's plan is printed and its deltas checked separately.
 *
 * THE THREE GATES, IN ORDER (all of them are refusals, never warnings):
 *   1. every address involved must be on a hard-coded allowlist of synthetic
 *      demo personas;
 *   2. the target must be explicitly acknowledged when it looks
 *      production-like (APP_ENV=production, or a non-local database host, or a
 *      database URL that cannot be parsed at all);
 *   3. the accounts behind those addresses must be flagged as demo accounts
 *      (accounts.is_demo) — checked against the database before any write.
 *
 * A tool that can erase a relationship must be boring and loud. There is no
 * "force" flag here, no wildcard, and no way to name a real address: the only
 * addresses this module will ever accept are the ones hard-coded below.
 *
 * This file imports no database driver and no Next.js module: it is the part
 * that a unit test can drive directly.
 */

import { canonicalPair, eventContextKey } from './introductions';
import { SERVICE_NOTICE_KINDS } from './service-notices';

/**
 * The synthetic personas this repository seeds (scripts/seed-demo.mts,
 * scripts/seed-demo-event.mts, scripts/two-user-walkthrough.mjs). Hard-coded on
 * purpose: an allowlist read from the environment is a configuration, and the
 * point of this guard is that it cannot be configured into erasing a real
 * relationship. The operator's own account is deliberately NOT here — the
 * walkthrough's operator is a real person, and their mutual introduction must
 * never be resettable by this command.
 */
export interface DemoPersona {
  readonly email: string;
  /** The display name the seed writes; shown in the plan so the operator sees
   *  which human the address belongs to before anything is deleted. */
  readonly label: string;
}

export const DEMO_PERSONAS: readonly DemoPersona[] = [
  { email: 'demo1@welcome.test', label: 'Анна Смирнова' },
  { email: 'demo2@welcome.test', label: 'Дмитрий Ковалёв' },
  { email: 'marta.demo@welcome.test', label: 'Marta Ruiz' },
  // The NON-MEMBER persona of the demo event (scripts/seed-demo-event.mts): the
  // one the two-person walkthrough's join step is demonstrated with, and the
  // reason this command grew a membership part at all.
  { email: 'lucia.demo@welcome.test', label: 'Lucía Ferrer' },
];

export const DEMO_EMAIL_ALLOWLIST: readonly string[] = DEMO_PERSONAS.map((p) => p.email);

/** The persona behind an allowlisted address, for the plan's own copy. An
 *  address that is not on the list has no persona and never reaches a plan. */
export function demoPersonaLabel(email: string): string {
  return DEMO_PERSONAS.find((p) => p.email === email)?.label ?? 'unknown persona';
}

/** The event the demo happens in (scripts/seed-demo-event.mts). */
export const DEFAULT_DEMO_EVENT_SLUG = 'welcome-demo-meetup';

/** The pair the two-person walkthrough spends (scripts/two-user-walkthrough.mjs:
 *  A = demo2, B = lucia.demo — the persona who arrives through the QR and JOINS
 *  the event, which is why the pair changed when the join step became live). */
export const DEFAULT_DEMO_PAIR: readonly [string, string] = ['demo2@welcome.test', 'lucia.demo@welcome.test'];

/** The explicit acknowledgement required when the target looks production-like. */
export const PRODUCTION_ACK_FLAG = '--i-know-this-is-production';

/** The flag that returns ONE persona to the non-member state of the named event. */
export const UNJOIN_FLAG = '--unjoin';

/** The outbox kinds that exist only *because* an introduction does: each one's
 *  subject_id is the introduction id, and each one's dedupe key contains it. */
export const INTRO_NOTICE_KINDS: readonly string[] = SERVICE_NOTICE_KINDS;


// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface DemoResetArgs {
  dryRun: boolean;
  acknowledged: boolean;
  eventSlug: string;
  pair: readonly [string, string];
  /** The address to return to the non-member state of the named event, or null
   *  when the membership part was not asked for. */
  unjoin: string | null;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

function flagValue(argv: readonly string[], name: string): { found: boolean; value: string | null } {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return { found: hit !== undefined, value: hit === undefined ? null : hit.slice(name.length + 3) };
}

/**
 * Parses the command line. A flag this command does not know, or a known flag
 * used with the wrong shape, is a refusal rather than something to ignore: a
 * typo in `--dry-run` must never turn into a real deletion, and a bare `--pair`
 * must never be read as "the default pair".
 */
export function parseDemoResetArgs(argv: readonly string[]): Parsed<DemoResetArgs> {
  const flags = new Set(['--dry-run', PRODUCTION_ACK_FLAG]);
  const valueFlags = new Set(['--event', '--pair', UNJOIN_FLAG]);

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

  const event = flagValue(argv, 'event');
  const pair = flagValue(argv, 'pair');
  const unjoin = flagValue(argv, 'unjoin');
  if (event.found && (event.value === null || event.value.length === 0)) {
    return { ok: false, code: 'empty_event', message: '--event= requires an event slug' };
  }
  if (pair.found && (pair.value === null || pair.value.length === 0)) {
    return { ok: false, code: 'empty_pair', message: '--pair= requires two comma-separated addresses' };
  }
  if (unjoin.found && (unjoin.value === null || unjoin.value.trim().length === 0)) {
    return { ok: false, code: 'empty_unjoin', message: `${UNJOIN_FLAG}= requires the address to return to the non-member state` };
  }

  let emails: readonly [string, string] = DEFAULT_DEMO_PAIR;
  if (pair.found && pair.value !== null) {
    const parts = pair.value.split(',').map((p) => p.trim());
    if (parts.length !== 2 || parts.some((p) => p.length === 0)) {
      return { ok: false, code: 'invalid_pair', message: '--pair= takes exactly two comma-separated addresses' };
    }
    emails = [parts[0]!, parts[1]!];
  }

  return {
    ok: true,
    value: {
      dryRun: argv.includes('--dry-run'),
      acknowledged: argv.includes(PRODUCTION_ACK_FLAG),
      eventSlug: event.value ?? DEFAULT_DEMO_EVENT_SLUG,
      pair: emails,
      unjoin: unjoin.value === null ? null : unjoin.value.trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// Target classification
// ---------------------------------------------------------------------------

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Does this target look production-like? Deliberately fails CLOSED: an
 * unset/unparsable database URL or a non-local host counts as production-like,
 * so the acknowledgement flag is required rather than optional.
 */
export function looksProductionLike(input: { appEnv?: string | undefined; databaseUrl?: string | undefined }): boolean {
  if (input.appEnv === 'production') return true;
  const url = input.databaseUrl;
  if (!url || url.trim().length === 0) return true;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true; // a URL we cannot read is not one we will call local
  }
  return !LOCAL_HOSTS.includes(host.toLowerCase());
}

// ---------------------------------------------------------------------------
// The gate: may this run at all?
// ---------------------------------------------------------------------------

export interface GuardInput {
  args: DemoResetArgs;
  appEnv: string | undefined;
  databaseUrl: string | undefined;
}

export interface GuardVerdict {
  productionLike: boolean;
}

export type Guard = { ok: true; value: GuardVerdict } | { ok: false; code: string; message: string };

/**
 * The pre-connection gate. Every refusal names the reason and the flag that
 * would lift it, so the operator is never left guessing why the tool said no.
 */
export function guardDemoReset(input: GuardInput): Guard {
  const { args } = input;

  const [first, second] = args.pair;
  if (first === second) {
    return {
      ok: false,
      code: 'refused_same_address',
      message: `REFUSED: --pair names the same address twice (${first}); a pair needs two different personas`,
    };
  }

  // Both parts name addresses, and EVERY address involved is checked — the
  // membership part's address included, which is why this reads the pair and the
  // unjoin target together rather than one at a time.
  const named = args.unjoin === null ? [...args.pair] : [...args.pair, args.unjoin];
  const offList = named.filter((email) => !DEMO_EMAIL_ALLOWLIST.includes(email));
  if (offList.length > 0) {
    return {
      ok: false,
      code: 'refused_not_allowlisted',
      message:
        `REFUSED: ${offList.join(', ')} ${offList.length === 1 ? 'is' : 'are'} not on the hard-coded allowlist of demo ` +
        `addresses. This command only ever touches ${DEMO_EMAIL_ALLOWLIST.join(', ')} — a real address cannot be erased ` +
        'through it, by design.',
    };
  }

  if (!input.databaseUrl || input.databaseUrl.trim().length === 0) {
    return {
      ok: false,
      code: 'refused_no_database_url',
      message:
        'REFUSED: no database target. Set DATABASE_URL (or NEON_CONN_DIRECT) to the database that holds the demo event.',
    };
  }

  const productionLike = looksProductionLike({ appEnv: input.appEnv, databaseUrl: input.databaseUrl });
  if (productionLike && !args.acknowledged) {
    return {
      ok: false,
      code: 'refused_production_not_acknowledged',
      message:
        `REFUSED: the target looks production-like (APP_ENV=${input.appEnv ?? 'unset'}, database host not local). ` +
        `Re-run with ${PRODUCTION_ACK_FLAG} if you really mean to touch it.`,
    };
  }

  return { ok: true, value: { productionLike } };
}

// ---------------------------------------------------------------------------
// The membership part (--unjoin): which persona qualifies, and its scope
// ---------------------------------------------------------------------------

export interface MembershipTarget {
  accountId: string;
  profileId: string;
}

/**
 * The account gate for the membership part. The SAME properties the
 * introduction part reads (exists, is_demo, active, has a profile) with one
 * deliberate difference: the membership itself is NOT required. Being outside
 * the event is the state this part produces, so a persona who is already
 * outside it is a NO-OP to report, never a refusal — that is what makes a second
 * run of the same command honest instead of an error.
 */
export function qualifyMembershipPersona(rows: readonly DemoAccountRow[], email: string): Parsed<MembershipTarget> {
  const row = rows.find((r) => r.email === email);
  if (!row || row.account_id === null) {
    return { ok: false, code: 'refused_account_missing', message: `REFUSED: no account for ${email} on this database` };
  }
  if (row.is_demo !== true) {
    return {
      ok: false,
      code: 'refused_not_demo',
      message: `REFUSED: the account for ${email} is not flagged as a demo account (accounts.is_demo), so this command will not touch it`,
    };
  }
  if (row.account_status !== 'active') {
    return {
      ok: false,
      code: 'refused_account_inactive',
      message: `REFUSED: the account for ${email} is ${row.account_status ?? 'unknown'}, not active`,
    };
  }
  if (row.profile_id === null) {
    return { ok: false, code: 'refused_no_profile', message: `REFUSED: the account for ${email} has no profile` };
  }
  return { ok: true, value: { accountId: row.account_id, profileId: row.profile_id } };
}

/** The exact scope of the membership part: ONE event × ONE profile. Both columns
 *  are named in the WHERE clause of every statement that touches it. */
export interface MembershipScope {
  eventId: string;
  eventSlug: string;
  profileId: string;
  email: string;
}

export function membershipResetScope(
  event: { id: string; slug: string },
  profileId: string,
  email: string,
): MembershipScope {
  return { eventId: event.id, eventSlug: event.slug, profileId, email };
}

/** The one counter the membership part moves. */
export interface MembershipCounts {
  memberships: number;
}

export function membershipDeltas(before: MembershipCounts, after: MembershipCounts): MembershipCounts {
  return { memberships: after.memberships - before.memberships };
}

/** True when the membership part changed nothing — the property a second run has. */
export function isMembershipNoOp(d: MembershipCounts): boolean {
  return d.memberships === 0;
}

/** One line per counter, in the membership report's fixed order. */
export function formatMembershipCounts(label: string, before: MembershipCounts, after: MembershipCounts): string[] {
  const d = membershipDeltas(before, after);
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  return [
    `  ${label}`,
    `    event memberships  ${before.memberships} → ${after.memberships}  (${sign(d.memberships)})`,
  ];
}

/**
 * Why the membership part removes the row and nothing else — stated where the
 * operator reads it, because "and nothing more" only means something if the
 * floor is named.
 */
export const WHY_THIS_MUCH_MEMBERSHIP =
  'WHY THIS MUCH AND NO MORE: the event page decides whether to offer the join action from ONE fact — an ' +
  'event_memberships row in state \'active\' for this profile and this event (src/lib/event-view.ts) — so that single ' +
  'row is the whole difference between the member state and the non-member state the demo needs. Deleting it removes ' +
  'nothing else: no table has a foreign key to event_memberships, so the schema cascades nothing, and the persona\'s ' +
  'own introductions, consents, blocks, notes and audit rows are rows about OTHER things (relationships, moderation, ' +
  'history) that happen to involve her — they are not part of "is she in this event", and deleting them would erase ' +
  'facts the demo must not invent or destroy. The membership row\'s own columns (offer/need tags, directory_visible, ' +
  'matching_enabled, attendance_source, registration_id) go with it because the row IS those values; the ' +
  'event.joined audit row stays, because the join DID happen. The command writes no audit row of its own: it runs ' +
  'without an actor account, and inventing one would put a person\'s name on an operator\'s maintenance run.';

// ---------------------------------------------------------------------------
// Which accounts qualify
// ---------------------------------------------------------------------------

/** The columns of the accounts/profile lookup this decision is made from. */
export interface DemoAccountRow {
  email: string;
  account_id: string | null;
  is_demo: boolean | null;
  account_status: string | null;
  profile_id: string | null;
}

export interface QualifiedAccounts {
  /** email → account/profile ids, in the order the pair was given. */
  readonly byEmail: ReadonlyMap<string, { accountId: string; profileId: string }>;
  readonly profileA: string;
  readonly profileB: string;
}

/**
 * Every account behind the named pair must exist, be flagged is_demo, be
 * active, and have a profile. Anything else is a refusal: the reason this
 * command is allowed to DELETE is that the rows belong to synthetic personas,
 * so "it looked like a demo account" is not good enough — the flag is read.
 */
export function qualifyDemoAccounts(
  rows: readonly DemoAccountRow[],
  pair: readonly [string, string],
): Parsed<QualifiedAccounts> {
  const byEmail = new Map<string, { accountId: string; profileId: string }>();

  for (const email of pair) {
    const row = rows.find((r) => r.email === email);
    if (!row || row.account_id === null) {
      return { ok: false, code: 'refused_account_missing', message: `REFUSED: no account for ${email} on this database` };
    }
    if (row.is_demo !== true) {
      return {
        ok: false,
        code: 'refused_not_demo',
        message: `REFUSED: the account for ${email} is not flagged as a demo account (accounts.is_demo), so this command will not touch it`,
      };
    }
    if (row.account_status !== 'active') {
      return {
        ok: false,
        code: 'refused_account_inactive',
        message: `REFUSED: the account for ${email} is ${row.account_status ?? 'unknown'}, not active`,
      };
    }
    if (row.profile_id === null) {
      return { ok: false, code: 'refused_no_profile', message: `REFUSED: the account for ${email} has no profile` };
    }
    byEmail.set(email, { accountId: row.account_id, profileId: row.profile_id });
  }

  const profileA = byEmail.get(pair[0])!.profileId;
  const profileB = byEmail.get(pair[1])!.profileId;
  if (profileA === profileB) {
    return { ok: false, code: 'refused_same_profile', message: 'REFUSED: both addresses resolve to the same profile' };
  }
  return { ok: true, value: { byEmail, profileA, profileB } };
}

// ---------------------------------------------------------------------------
// Which rows qualify
// ---------------------------------------------------------------------------

export interface IntroductionRow {
  id: string;
  event_id: string | null;
  context_key: string;
  profile_a: string;
  profile_b: string;
  state: string;
  /** Read from the database so the plan can name the row it is about to delete;
   *  the selector below never looks at it. */
  created_at?: string | Date;
}

export interface ResetScope {
  eventId: string;
  eventSlug: string;
  contextKey: string;
  profileA: string;
  profileB: string;
}

/** The exact scope: one event context, one canonical pair. Derived with the
 *  product's own helpers, so the reset and POST /api/introductions agree on what
 *  "the same pair in the same context" means. */
export function demoResetScope(event: { id: string; slug: string }, profiles: readonly [string, string]): ResetScope {
  const pair = canonicalPair(profiles[0], profiles[1]);
  return {
    eventId: event.id,
    eventSlug: event.slug,
    contextKey: eventContextKey(event.id),
    profileA: pair.profileA,
    profileB: pair.profileB,
  };
}

/**
 * Selects the rows to delete. Duck-typed on the three columns that make a row
 * THIS pair's row in THIS context, so anything else — another pair, another
 * event, a personal-context introduction between the same two people — is not
 * selected and therefore cannot be deleted.
 */
export function selectIntroductionsToReset(
  rows: readonly IntroductionRow[],
  scope: ResetScope,
): readonly IntroductionRow[] {
  return rows.filter(
    (row) => row.context_key === scope.contextKey && row.profile_a === scope.profileA && row.profile_b === scope.profileB,
  );
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** The four counters the report must carry, plus the cascade it triggers. */
export interface ResetCounts {
  introductions: number;
  consents: number;
  notices: number;
  audit: number;
  attempts: number;
}

export interface ResetReport {
  /** Rows of the named pair in the named event context (and the cascade from
   *  them) — the only thing this command may change. */
  scoped: { before: ResetCounts; after: ResetCounts };
  /** Whole-table totals, so "nothing else moved" is visible rather than
   *  asserted. */
  totals: { before: ResetCounts; after: ResetCounts };
  deletedIntroductionIds: readonly string[];
}

export function deltas(before: ResetCounts, after: ResetCounts): ResetCounts {
  return {
    introductions: after.introductions - before.introductions,
    consents: after.consents - before.consents,
    notices: after.notices - before.notices,
    audit: after.audit - before.audit,
    attempts: after.attempts - before.attempts,
  };
}

/** True when a run changed nothing — the property the second run must have. */
export function isNoOp(d: ResetCounts): boolean {
  return d.introductions === 0 && d.consents === 0 && d.notices === 0 && d.audit === 0 && d.attempts === 0;
}

/** One line per counter, in the report's fixed order. */
export function formatCounts(label: string, before: ResetCounts, after: ResetCounts): string[] {
  const d = deltas(before, after);
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  return [
    `  ${label}`,
    `    introductions      ${before.introductions} → ${after.introductions}  (${sign(d.introductions)})`,
    `    consents           ${before.consents} → ${after.consents}  (${sign(d.consents)})`,
    `    notices            ${before.notices} → ${after.notices}  (${sign(d.notices)})`,
    `    audit rows         ${before.audit} → ${after.audit}  (${sign(d.audit)})`,
    `    delivery attempts  ${before.attempts} → ${after.attempts}  (${sign(d.attempts)}, cascade of the notices)`,
  ];
}

/**
 * Why the introduction row itself has to go — stated where the operator reads
 * it, because "least destructive" only means something if the floor is named.
 */
export const WHY_THIS_MUCH =
  'WHY THIS MUCH AND NO MORE: introductions has UNIQUE(context_key, profile_a, profile_b), so a row that stayed would ' +
  'make the next proposal answer already_existed=true instead of creating a fresh pending card; and the event intro ' +
  'cooldown excludes a pair that has ANY introduction in the context, so recommendations would never offer the pair ' +
  'again. Those two rules are exactly what makes the pair undemonstrable, and deleting the ONE introduction row for ' +
  'this pair in this event context is the least destructive change that lifts both. The consent rows go with it by the ' +
  'schema\'s own ON DELETE CASCADE; the introduction\'s own outbox notices go because each one\'s subject_id and dedupe ' +
  'key IS that introduction, so keeping them would let the worker announce an introduction that no longer exists. ' +
  'audit_events is append-only by design: the actions DID happen, and deleting their record would be a bigger lie ' +
  'than the leftover row, so the audit delta is expected to be zero.';

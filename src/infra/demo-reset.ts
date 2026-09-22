import type { Sql, TransactionSql } from 'postgres';
import { emailLookupHash } from '../lib/crypto';
import {
  demoResetScope,
  INTRO_NOTICE_KINDS,
  membershipResetScope,
  qualifyDemoAccounts,
  qualifyMembershipPersona,
  selectIntroductionsToReset,
  type DemoAccountRow,
  type IntroductionRow,
  type MembershipCounts,
  type MembershipScope,
  type Parsed,
  type ResetCounts,
  type ResetScope,
} from '../domain/demo-reset';

/**
 * The database half of `pnpm demo:reset`. Every statement here is scoped by the
 * three columns that define the target — context_key, profile_a, profile_b — or
 * by the introduction ids selected under that scope. Nothing in this file can
 * reach a row outside it, and nothing here decides policy: the guards and the
 * selection live in src/domain/demo-reset.ts, where a unit test can drive them.
 */

export interface DemoResetAccount {
  email: string;
  accountId: string;
  profileId: string;
}

export interface DemoResetTarget {
  scope: ResetScope;
  /** In the order the pair was named, so the plan reads the way the operator typed it. */
  accounts: readonly DemoResetAccount[];
  introCooldownDays: number;
}

interface EventRow {
  id: string;
  slug: string;
  intro_cooldown_days: number;
}

/**
 * Resolves the named event and the named pair, and applies the account gate
 * (exists / is_demo / active / has a profile / is an active member of that
 * event). Runs before anything is selected or deleted: if this returns a
 * refusal, the command has not written a single row.
 */
export async function loadDemoTarget(
  sql: Sql,
  options: {
    eventSlug: string;
    pair: readonly [string, string];
    pepper: string;
    /**
     * Addresses this run is DELIBERATELY returning to the non-member state — the
     * same invocation's `--unjoin` target. They are exempt from the "must be an
     * active member" requirement, because the run itself removes that
     * membership: without the exemption the documented restore command would
     * work once and then refuse itself on the second (idempotent) run. The
     * account-level gates below still apply to them, unchanged — is_demo,
     * active, with a profile.
     */
    allowNonMember?: readonly string[];
  },
): Promise<Parsed<DemoResetTarget>> {
  const eventRows = await sql<EventRow[]>`
    SELECT id, slug, intro_cooldown_days FROM events WHERE slug = ${options.eventSlug} LIMIT 1
  `;
  const event = eventRows[0];
  if (!event) {
    return {
      ok: false,
      code: 'refused_event_missing',
      message: `REFUSED: no event with slug "${options.eventSlug}" on this database`,
    };
  }

  // Email never travels to the database in the clear: the lookup key is the
  // same HMAC the app uses (src/lib/crypto.ts).
  const hashes = options.pair.map((email) => emailLookupHash(email, options.pepper));
  const accountRows = await sql<{ email_lookup_hash: string; account_id: string; is_demo: boolean; account_status: string; profile_id: string | null }[]>`
    SELECT a.email_lookup_hash, a.id AS account_id, a.is_demo, a.status AS account_status,
           (SELECT p.id FROM profiles p WHERE p.account_id = a.id LIMIT 1) AS profile_id
    FROM accounts a
    WHERE a.email_lookup_hash = ANY(${hashes}::text[])
  `;
  const byHash = new Map(accountRows.map((row) => [row.email_lookup_hash, row]));
  const rows: DemoAccountRow[] = options.pair.map((email, i) => {
    const row = byHash.get(hashes[i]!);
    return {
      email,
      account_id: row?.account_id ?? null,
      is_demo: row?.is_demo ?? null,
      account_status: row?.account_status ?? null,
      profile_id: row?.profile_id ?? null,
    };
  });

  const qualified = qualifyDemoAccounts(rows, options.pair);
  if (!qualified.ok) return qualified;

  const profileIds = [qualified.value.profileA, qualified.value.profileB];
  const memberships = await sql<{ profile_id: string }[]>`
    SELECT profile_id FROM event_memberships
    WHERE event_id = ${event.id} AND state = 'active' AND profile_id = ANY(${profileIds}::uuid[])
  `;
  const active = new Set(memberships.map((m) => m.profile_id));
  const exempt = new Set(options.allowNonMember ?? []);
  const missing = options.pair.filter((email, i) => !active.has(profileIds[i]!) && !exempt.has(email));
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'refused_not_a_member',
      message:
        `REFUSED: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not an active member of ` +
        `"${options.eventSlug}" — the pair cannot be demonstrated in an event one of them has not joined, and this ` +
        'command will not infer a different event. (Run the introductions part once both are in the event — the ' +
        `walkthrough brings the second person in — or add --unjoin=<email> if this run is about returning that ` +
        'persona to the non-member state.)',
    };
  }

  // The context key comes from the product's own helper, so this command and
  // POST /api/introductions agree on what "this pair in this event" means.
  const scope = demoResetScope(
    { id: event.id, slug: event.slug },
    [qualified.value.profileA, qualified.value.profileB],
  );

  return {
    ok: true,
    value: {
      scope,
      accounts: options.pair.map((email) => ({
        email,
        accountId: qualified.value.byEmail.get(email)!.accountId,
        profileId: qualified.value.byEmail.get(email)!.profileId,
      })),
      introCooldownDays: event.intro_cooldown_days,
    },
  };
}

/**
 * The rows this run would delete: the named pair's introductions in the named
 * event context. The WHERE clause is the scope, and the pure selector is applied
 * again on the result so that a database returning something unexpected cannot
 * widen the scope.
 */
export async function selectResetIntroductions(sql: Sql, scope: ResetScope): Promise<readonly IntroductionRow[]> {
  const rows = await sql<IntroductionRow[]>`
    SELECT id, event_id, context_key, profile_a, profile_b, state, created_at
    FROM introductions
    WHERE context_key = ${scope.contextKey} AND profile_a = ${scope.profileA} AND profile_b = ${scope.profileB}
  `;
  return selectIntroductionsToReset(rows, scope);
}

/**
 * Counts the four things the report names — introductions, consents, notices,
 * audit rows — plus the delivery attempts that cascade with the notices, in two
 * dimensions: `scoped` (the named pair's rows, and the cascade from them) and
 * `totals` (whole table). Publishing both is what makes "nothing outside the
 * named pair and event was touched" checkable by the reader instead of asserted
 * by the tool: the totals must move by exactly the scoped amount.
 *
 * It is called with the SAME ids before and after the deletion. That is what
 * lets the report show the one counter that deliberately does NOT move: the
 * audit rows are still there after the run, found by the ids the plan selected.
 */
export async function countResetRows(
  sql: Sql | TransactionSql,
  scope: ResetScope,
  introductionIds: readonly string[],
): Promise<{ scoped: ResetCounts; totals: ResetCounts }> {
  const ids = [...introductionIds];
  const kinds = [...INTRO_NOTICE_KINDS];

  const scoped = await sql<ResetCounts[]>`
    SELECT
      (SELECT count(*)::int FROM introductions
        WHERE context_key = ${scope.contextKey} AND profile_a = ${scope.profileA} AND profile_b = ${scope.profileB}
      ) AS introductions,
      (SELECT count(*)::int FROM introduction_consents
        WHERE introduction_id = ANY(${ids}::uuid[])
      ) AS consents,
      (SELECT count(*)::int FROM outbox_jobs
        WHERE subject_id = ANY(${ids}::uuid[]) AND kind = ANY(${kinds}::text[])
      ) AS notices,
      (SELECT count(*)::int FROM audit_events
        WHERE target_type = 'introduction' AND target_id = ANY(${ids}::text[])
      ) AS audit,
      (SELECT count(*)::int FROM delivery_attempts
        WHERE job_id IN (SELECT id FROM outbox_jobs WHERE subject_id = ANY(${ids}::uuid[]) AND kind = ANY(${kinds}::text[]))
      ) AS attempts
  `;

  const totals = await sql<ResetCounts[]>`
    SELECT
      (SELECT count(*)::int FROM introductions) AS introductions,
      (SELECT count(*)::int FROM introduction_consents) AS consents,
      (SELECT count(*)::int FROM outbox_jobs WHERE kind = ANY(${kinds}::text[])) AS notices,
      (SELECT count(*)::int FROM audit_events) AS audit,
      (SELECT count(*)::int FROM delivery_attempts) AS attempts
  `;

  return { scoped: scoped[0]!, totals: totals[0]! };
}

/**
 * The deletion itself, in ONE transaction: the introduction's own outbox notices
 * first (they have no foreign key to it — subject_id is a plain uuid), then the
 * introduction rows, whose consents the schema cascades. Both statements carry
 * the full scope in their WHERE clause, so even the delete cannot reach a row
 * the plan did not name.
 */
export async function applyReset(
  sql: Sql,
  scope: ResetScope,
  introductionIds: readonly string[],
): Promise<{ notices: number; introductions: number }> {
  const ids = [...introductionIds];
  const kinds = [...INTRO_NOTICE_KINDS];
  return sql.begin(async (tx) => {
    const notices = await tx<{ id: string }[]>`
      DELETE FROM outbox_jobs
      WHERE subject_id = ANY(${ids}::uuid[]) AND kind = ANY(${kinds}::text[])
      RETURNING id
    `;
    const introductions = await tx<{ id: string }[]>`
      DELETE FROM introductions
      WHERE id = ANY(${ids}::uuid[])
        AND context_key = ${scope.contextKey} AND profile_a = ${scope.profileA} AND profile_b = ${scope.profileB}
      RETURNING id
    `;
    return { notices: notices.length, introductions: introductions.length };
  });
}

// ---------------------------------------------------------------------------
// The membership part (`--unjoin`): the row, its plan, and its deletion
// ---------------------------------------------------------------------------

/** The membership row as the plan needs to name it before it goes. */
export interface MembershipRow {
  id: string;
  state: string;
  directory_visible: boolean;
  matching_enabled: boolean;
  attendance_source: string;
  created_at: Date | string;
}

export interface MembershipResetTarget {
  scope: MembershipScope;
  accountId: string;
  /** The row this run would remove, or null when the persona is already outside
   *  the event (the no-op this command reports instead of refusing). */
  membership: MembershipRow | null;
}

/**
 * Resolves the named event and the named persona and applies the account gate
 * (exists / is_demo / active / has a profile) — the same gate the introduction
 * part applies, without its membership requirement (see
 * qualifyMembershipPersona). Runs before anything is selected or deleted.
 */
export async function loadMembershipTarget(
  sql: Sql,
  options: { eventSlug: string; email: string; pepper: string },
): Promise<Parsed<MembershipResetTarget>> {
  const eventRows = await sql<{ id: string; slug: string }[]>`
    SELECT id, slug FROM events WHERE slug = ${options.eventSlug} LIMIT 1
  `;
  const event = eventRows[0];
  if (!event) {
    return {
      ok: false,
      code: 'refused_event_missing',
      message: `REFUSED: no event with slug "${options.eventSlug}" on this database`,
    };
  }

  const hash = emailLookupHash(options.email, options.pepper);
  const accountRows = await sql<
    { email_lookup_hash: string; account_id: string; is_demo: boolean; account_status: string; profile_id: string | null }[]
  >`
    SELECT a.email_lookup_hash, a.id AS account_id, a.is_demo, a.status AS account_status,
           (SELECT p.id FROM profiles p WHERE p.account_id = a.id LIMIT 1) AS profile_id
    FROM accounts a
    WHERE a.email_lookup_hash = ${hash}
  `;
  const row = accountRows[0];
  const rows: DemoAccountRow[] = [
    {
      email: options.email,
      account_id: row?.account_id ?? null,
      is_demo: row?.is_demo ?? null,
      account_status: row?.account_status ?? null,
      profile_id: row?.profile_id ?? null,
    },
  ];
  const qualified = qualifyMembershipPersona(rows, options.email);
  if (!qualified.ok) return qualified;

  const membershipRows = await sql<MembershipRow[]>`
    SELECT id, state, directory_visible, matching_enabled, attendance_source, created_at
    FROM event_memberships
    WHERE event_id = ${event.id} AND profile_id = ${qualified.value.profileId}
    LIMIT 1
  `;

  return {
    ok: true,
    value: {
      scope: membershipResetScope({ id: event.id, slug: event.slug }, qualified.value.profileId, options.email),
      accountId: qualified.value.accountId,
      membership: membershipRows[0] ?? null,
    },
  };
}

/**
 * The single counter the membership report publishes, in two dimensions: the
 * named persona's row in the named event, and the whole table. Both are read
 * with the SAME scope before and after, so "exactly one row, and nothing else"
 * is checkable by the reader instead of asserted by the tool.
 */
export async function countMembershipRows(
  sql: Sql | TransactionSql,
  scope: MembershipScope,
): Promise<{ scoped: MembershipCounts; totals: MembershipCounts }> {
  const scoped = await sql<{ memberships: number }[]>`
    SELECT count(*)::int AS memberships FROM event_memberships
    WHERE event_id = ${scope.eventId} AND profile_id = ${scope.profileId}
  `;
  const totals = await sql<{ memberships: number }[]>`
    SELECT count(*)::int AS memberships FROM event_memberships
  `;
  return { scoped: { memberships: scoped[0]!.memberships }, totals: { memberships: totals[0]!.memberships } };
}

/**
 * The deletion: ONE statement, scoped by BOTH columns that define the target
 * (event_id AND profile_id), so it cannot reach another persona's membership in
 * this event or this persona's membership in another event. Returns the ids it
 * removed (0 or 1 — the schema has UNIQUE(event_id, profile_id)).
 */
export async function applyMembershipReset(sql: Sql, scope: MembershipScope): Promise<readonly string[]> {
  const removed = await sql<{ id: string }[]>`
    DELETE FROM event_memberships
    WHERE event_id = ${scope.eventId} AND profile_id = ${scope.profileId}
    RETURNING id
  `;
  return removed.map((row) => row.id);
}

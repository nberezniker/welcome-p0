import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { PATCH as membershipPatchRoute } from '../../src/app/api/me/memberships/[membershipId]/route';
import { POST as createIntroRoute } from '../../src/app/api/introductions/route';
import { POST as respondRoute } from '../../src/app/api/introductions/[id]/respond/route';
import { getSql, closeSql } from '../../src/lib/db';
import { loadEventView } from '../../src/lib/event-view';
import { recommendForEvent } from '../../src/domain/recommendations';
import {
  deltas,
  isMembershipNoOp,
  isNoOp,
  membershipDeltas,
  selectIntroductionsToReset,
} from '../../src/domain/demo-reset';
import {
  applyMembershipReset,
  applyReset,
  countMembershipRows,
  countResetRows,
  loadDemoTarget,
  loadMembershipTarget,
  selectResetIntroductions,
} from '../../src/infra/demo-reset';
import { accountIdFromCookie, assertStatus, loginViaOtp, makeRequest, uniqueEmail } from './helpers';

/**
 * `pnpm demo:reset` against the test database, end to end.
 *
 * The scenario is the one the command exists for and it is built through the
 * PRODUCT's own routes, not by inserting rows: two demo accounts join an event,
 * A proposes, B accepts, the pair goes mutual — which is exactly what the
 * two-person walkthrough does to the two personas in the live demo event, and
 * exactly what makes the pair undemonstrable afterwards (one introduction per
 * pair per event context, plus the event's intro cooldown).
 *
 * The test then proves, in order: the pair really is spent (a second proposal
 * answers already_existed=true and recommendations drop the pair); one reset
 * removes the pair's rows and nothing else; a second reset changes nothing at
 * all (every delta zero); and the pair is demonstrable again (a fresh proposal
 * creates a fresh pending introduction).
 */

after(async () => {
  await closeSql();
});

interface User {
  email: string;
  cookie: string;
  accountId: string;
  profileId: string;
}

async function login(prefix: string, tags: { offers?: string[]; needs?: string[] } = {}): Promise<User> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: {
        display_name: `Demo reset ${prefix}`,
        languages: ['en'],
        offer_tags: tags.offers ?? [],
        need_tags: tags.needs ?? [],
      },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { email, cookie, accountId, profileId: rows[0]!.id };
}

interface SpentPair {
  eventId: string;
  eventSlug: string;
  a: User;
  b: User;
  introId: string;
  /** A THIRD person in the same event, with an introduction of their own to a
   *  fourth: the row a reset of the demo pair must never touch. */
  outsiderIntroId: string;
}

/**
 * Seeds the pair through the real routes and leaves it exactly where the
 * walkthrough leaves the demo personas: mutual, with its consent rows, its
 * service notices and its audit trail in place.
 */
async function seedSpentPair(prefix: string): Promise<SpentPair> {
  const { cookie: orgCookie } = await login(`${prefix}-org`);
  const eventSlug = `demo-reset-${prefix}-${randomUUID().slice(0, 8)}`;
  const eventRes = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: `Demo reset meetup ${prefix}`, mode: 'offline', access_mode: 'public', timezone: 'UTC', slug: eventSlug },
      cookie: orgCookie,
    }),
  );
  assertStatus(eventRes, 201);
  const { event } = (await eventRes.json()) as { event: { id: string; slug: string } };

  const a = await login(`${prefix}-a`, { offers: ['mentoring'], needs: ['frontend'] });
  const b = await login(`${prefix}-b`, { offers: ['frontend'], needs: ['mentoring'] });
  const c = await login(`${prefix}-c`, { offers: ['growth'], needs: ['design'] });
  const d = await login(`${prefix}-d`, { offers: ['design'], needs: ['growth'] });

  const sql = getSql();
  for (const user of [a, b, c, d]) {
    const joined = await joinRoute(makeRequest(`/api/events/${event.id}/join`, { body: {}, cookie: user.cookie }), {
      params: Promise.resolve({ eventIdOrSlug: event.id }),
    });
    assertStatus(joined, 200);
    const membership = await sql<{ id: string }[]>`
      SELECT id FROM event_memberships WHERE event_id = ${event.id} AND profile_id = ${user.profileId} LIMIT 1
    `;
    const patched = await membershipPatchRoute(
      makeRequest(`/api/me/memberships/${membership[0]!.id}`, {
        body: { directory_visible: true, matching_enabled: true },
        cookie: user.cookie,
      }),
      { params: Promise.resolve({ membershipId: membership[0]!.id }) },
    );
    assertStatus(patched, 200);
  }

  // The accounts are synthetic and flagged as such — the flag is what the
  // reset's account gate reads (scripts/seed-demo.mts does the same for the
  // live demo personas).
  await sql`UPDATE accounts SET is_demo = true WHERE id = ANY(${[a.accountId, b.accountId, c.accountId, d.accountId]}::uuid[])`;

  const propose = (from: User, to: User) =>
    createIntroRoute(makeRequest('/api/introductions', { body: { target_profile_id: to.profileId, event_id: event.id }, cookie: from.cookie }));

  const proposed = await propose(a, b);
  assertStatus(proposed, 200);
  const { introduction } = (await proposed.json()) as { introduction: { id: string }; already_existed: boolean };

  const accepted = await respondRoute(
    makeRequest(`/api/introductions/${introduction.id}/respond`, { body: { decision: 'accept', reveal_fields: ['telegram_username'] }, cookie: b.cookie }),
    { params: Promise.resolve({ id: introduction.id }) },
  );
  assertStatus(accepted, 200);

  // The outsider pair: same event, same context key, different people.
  const outsider = await propose(c, d);
  assertStatus(outsider, 200);
  const outsiderIntro = (await outsider.json()) as { introduction: { id: string } };

  return { eventId: event.id, eventSlug: event.slug, a, b, introId: introduction.id, outsiderIntroId: outsiderIntro.introduction.id };
}

test('demo reset: one reset returns the spent pair to a demonstrable state, and nothing else moves', async () => {
  const { eventId, eventSlug, a, b, introId, outsiderIntroId } = await seedSpentPair('reset1');
  const sql = getSql();
  const pepper = process.env.HASH_PEPPER!;

  // ── the pair is spent: the product itself says so, twice ──────────────────
  const again = await createIntroRoute(
    makeRequest('/api/introductions', { body: { target_profile_id: b.profileId, event_id: eventId }, cookie: a.cookie }),
  );
  assertStatus(again, 200);
  const againBody = (await again.json()) as { introduction: { id: string }; already_existed: boolean };
  assert.equal(againBody.already_existed, true, 'a spent pair answers already_existed=true');
  assert.equal(againBody.introduction.id, introId, 'and it is the SAME row — there is no fresh pending card');

  const before = await recommendForEvent(sql, { accountId: a.accountId, profileId: a.profileId }, eventId, 10);
  assert.equal(
    before.items.some((item) => item.profile_id === b.profileId),
    false,
    'the event intro cooldown keeps the spent pair out of recommendations',
  );

  // ── the plan: what this run would remove ─────────────────────────────────
  const target = await loadDemoTarget(sql, { eventSlug, pair: [a.email, b.email], pepper });
  assert.equal(target.ok, true, target.ok ? '' : target.message);
  assert.ok(target.ok);
  const scope = target.value.scope;
  const rows = await selectResetIntroductions(sql, scope);
  assert.deepEqual(rows.map((r) => r.id), [introId], 'exactly one introduction is in scope');
  const ids = rows.map((r) => r.id);

  const countsBefore = await countResetRows(sql, scope, ids);
  assert.equal(countsBefore.scoped.introductions, 1);
  assert.equal(countsBefore.scoped.consents, 2, 'both parties consented (initiator implicitly)');
  assert.equal(countsBefore.scoped.notices, 3, 'one requested notice + one mutual notice per side');
  assert.ok(countsBefore.scoped.audit > 0, 'the actions were audited');

  // ── the removal ─────────────────────────────────────────────────────────
  const removed = await applyReset(sql, scope, ids);
  assert.equal(removed.introductions, 1);
  assert.equal(removed.notices, 3);

  const countsAfter = await countResetRows(sql, scope, ids);
  const scoped = deltas(countsBefore.scoped, countsAfter.scoped);
  assert.deepEqual(scoped, { introductions: -1, consents: -2, notices: -3, audit: 0, attempts: 0 });

  // The cascade really happened, and the audit rows really did not.
  const leftConsents = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM introduction_consents WHERE introduction_id = ${introId}`;
  assert.equal(leftConsents[0]!.count, 0);
  const leftNotices = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM outbox_jobs WHERE subject_id = ${introId}`;
  assert.equal(leftNotices[0]!.count, 0);
  const leftAudit = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM audit_events WHERE target_type = 'introduction' AND target_id = ${introId}`;
  assert.equal(leftAudit[0]!.count, countsBefore.scoped.audit, 'audit_events is append-only: the record stays');

  // ── the scope: the other pair in the SAME event context is untouched ─────
  const outsider = await sql<{ id: string; state: string }[]>`SELECT id, state FROM introductions WHERE id = ${outsiderIntroId}`;
  assert.equal(outsider.length, 1, 'a different pair in the same event must survive the reset');
  assert.equal(outsider[0]!.state, 'pending', 'and it survives in the state it was in');
  const totals = deltas(countsBefore.totals, countsAfter.totals);
  assert.equal(totals.introductions, scoped.introductions, 'the whole table moved by exactly the scoped amount');
  assert.equal(totals.consents, scoped.consents);
  assert.equal(totals.notices, scoped.notices);
  assert.equal(totals.audit, 0, 'nothing anywhere in audit_events moved');

  // ── demonstrable again, through the product ─────────────────────────────
  // Recommendations first: with nothing left for the pair, the cooldown and the
  // "no active pair" rule no longer exclude B — which is the state the demo
  // needs before A can propose again.
  const recommended = await recommendForEvent(sql, { accountId: a.accountId, profileId: a.profileId }, eventId, 10);
  assert.equal(
    recommended.items.some((item) => item.profile_id === b.profileId),
    true,
    'the pair is back in recommendations, so the flow can be shown again',
  );

  const fresh = await createIntroRoute(
    makeRequest('/api/introductions', { body: { target_profile_id: b.profileId, event_id: eventId }, cookie: a.cookie }),
  );
  assertStatus(fresh, 200);
  const freshBody = (await fresh.json()) as { introduction: { id: string; state: string }; already_existed: boolean };
  assert.equal(freshBody.already_existed, false, 'the next proposal creates a fresh request');
  assert.equal(freshBody.introduction.state, 'pending');
  assert.notEqual(freshBody.introduction.id, introId);
});

test('demo reset: the second run is a no-op — every delta is zero', async () => {
  const { eventSlug, a, b, introId } = await seedSpentPair('reset2');
  const sql = getSql();
  const pepper = process.env.HASH_PEPPER!;

  const target = await loadDemoTarget(sql, { eventSlug, pair: [a.email, b.email], pepper });
  assert.ok(target.ok);
  const scope = target.value.scope;

  // Run one.
  const first = await selectResetIntroductions(sql, scope);
  assert.deepEqual(first.map((r) => r.id), [introId]);
  await applyReset(sql, scope, first.map((r) => r.id));

  // Run two: nothing is selected, nothing is deleted, every counter is still.
  const second = await selectResetIntroductions(sql, scope);
  const secondIds = second.map((r) => r.id);
  assert.deepEqual(secondIds, [], 'there is nothing left to remove');
  const empty = await applyReset(sql, scope, secondIds);
  assert.deepEqual(empty, { introductions: 0, notices: 0 });

  const before = await countResetRows(sql, scope, []);
  const after = await countResetRows(sql, scope, []);
  const scoped = deltas(before.scoped, after.scoped);
  const totals = deltas(before.totals, after.totals);
  assert.deepEqual(scoped, { introductions: 0, consents: 0, notices: 0, audit: 0, attempts: 0 });
  assert.deepEqual(totals, { introductions: 0, consents: 0, notices: 0, audit: 0, attempts: 0 });
  assert.equal(isNoOp(scoped) && isNoOp(totals), true);
});

test('demo reset: the database gate refuses an account the seeds did not mark as demo', async () => {
  const { eventSlug, a, b } = await seedSpentPair('reset3');
  const sql = getSql();
  const pepper = process.env.HASH_PEPPER!;

  await sql`UPDATE accounts SET is_demo = false WHERE id = ${b.accountId}`;
  const refused = await loadDemoTarget(sql, { eventSlug, pair: [a.email, b.email], pepper });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.code, 'refused_not_demo');

  // An address that is not on this database at all is refused the same way, and
  // the refusal happens before anything is selected or deleted.
  const missing = await loadDemoTarget(sql, { eventSlug, pair: [a.email, 'nobody@welcome.test'], pepper });
  assert.equal(missing.ok === false && missing.code, 'refused_account_missing');

  const wrongEvent = await loadDemoTarget(sql, { eventSlug: 'no-such-demo-event', pair: [a.email, b.email], pepper });
  assert.equal(wrongEvent.ok === false && wrongEvent.code, 'refused_event_missing');
});

test('demo reset: the selection cannot be widened by rows the scope does not name', async () => {
  const { eventSlug, a, b, outsiderIntroId } = await seedSpentPair('reset4');
  const sql = getSql();
  const pepper = process.env.HASH_PEPPER!;

  const target = await loadDemoTarget(sql, { eventSlug, pair: [a.email, b.email], pepper });
  assert.ok(target.ok);
  const scope = target.value.scope;

  // Every introduction in this event context, then the same rows through the
  // pure selector: only the named pair's row qualifies, and the outsider pair
  // — same context key — is not selected even though the SQL above saw it.
  const all = await sql<{ id: string; context_key: string; profile_a: string; profile_b: string; event_id: string | null; state: string }[]>`
    SELECT id, context_key, profile_a, profile_b, event_id, state FROM introductions WHERE context_key = ${scope.contextKey}
  `;
  assert.equal(all.length, 2, 'two introductions exist in this event context');
  const selected = selectIntroductionsToReset(all, scope);
  assert.equal(selected.length, 1);
  assert.notEqual(selected[0]!.id, outsiderIntroId);

  // And the selector on the raw rows of the OTHER pair selects nothing.
  const other = all.filter((row) => row.id === outsiderIntroId);
  assert.deepEqual(selectIntroductionsToReset(other, scope), []);
});

/**
 * THE MEMBERSHIP PART (`--unjoin`), against the test database.
 *
 * The scenario is the one the live walkthrough now ends in: a persona has JOINED
 * the demo event (through the product's own route), and the next demo needs her
 * outside it again — the join affordance, the non-member state and the card's
 * "nothing to connect here yet" are exactly what the step demonstrates. This
 * test proves the reset removes ONE row, that the product's own view of her
 * flips with it, that nothing else follows it, that the introductions part knows
 * the order it must run in, and that a second run is a no-op.
 */
test('demo reset: the membership part returns the joiner to the non-member state, and nothing else moves', async () => {
  const { eventId, eventSlug, a, b } = await seedSpentPair('unjoin1');
  const sql = getSql();
  const pepper = process.env.HASH_PEPPER!;

  // The fixture joined her through POST /api/events/<id>/join; the product's own
  // view of the event confirms she is in the room.
  const beforeView = await loadEventView(sql, eventSlug, b.accountId);
  assert.equal(beforeView?.viewer.is_member, true, 'the fixture must leave her a member');

  const target = await loadMembershipTarget(sql, { eventSlug, email: b.email, pepper });
  assert.equal(target.ok, true, target.ok ? '' : target.message);
  assert.ok(target.ok);
  const scope = target.value.scope;
  assert.equal(scope.profileId, b.profileId, 'the scope names the profile behind the address');
  assert.equal(target.value.membership?.state, 'active');

  const before = await countMembershipRows(sql, scope);
  assert.equal(before.scoped.memberships, 1, 'one membership for this persona in this event');
  const membershipsInEventBefore = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM event_memberships WHERE event_id = ${eventId}
  `;
  const introductionsBefore = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM introductions WHERE event_id = ${eventId}
  `;
  const auditBefore = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM audit_events WHERE actor_account_id = ${b.accountId}
  `;

  // ── the removal, scoped by BOTH columns ──────────────────────────────────
  const removed = await applyMembershipReset(sql, scope);
  assert.equal(removed.length, 1);

  const after = await countMembershipRows(sql, scope);
  assert.deepEqual(membershipDeltas(before.scoped, after.scoped), { memberships: -1 });
  assert.deepEqual(
    membershipDeltas(before.totals, after.totals),
    { memberships: -1 },
    'the whole table moved by exactly the scoped amount — nothing else changed memberships',
  );

  // ── the product agrees: the join affordance is back ──────────────────────
  const afterView = await loadEventView(sql, eventSlug, b.accountId);
  assert.equal(afterView?.viewer.is_member, false, 'the event page must offer the join action again');
  assert.equal(afterView?.viewer.online_link, null, 'and no member-only value may leak with the row gone');

  // ── nothing else followed it ─────────────────────────────────────────────
  // No table references event_memberships, so the schema cascades nothing, and
  // every other row about this persona is a row about something else.
  const membershipsInEventAfter = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM event_memberships WHERE event_id = ${eventId}
  `;
  assert.equal(membershipsInEventAfter[0]!.count, membershipsInEventBefore[0]!.count - 1, 'the other members are untouched');
  const introductionsAfter = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM introductions WHERE event_id = ${eventId}
  `;
  assert.equal(introductionsAfter[0]!.count, introductionsBefore[0]!.count, 'her introductions are NOT part of her membership');
  const profile = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE id = ${b.profileId}`;
  assert.equal(profile.length, 1, 'her profile survives');
  const account = await sql<{ status: string }[]>`SELECT status FROM accounts WHERE id = ${b.accountId}`;
  assert.equal(account[0]!.status, 'active', 'her account survives');
  const auditAfter = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM audit_events WHERE actor_account_id = ${b.accountId}
  `;
  assert.equal(auditAfter[0]!.count, auditBefore[0]!.count, 'audit_events is append-only: the join DID happen');

  // ── the order the two parts must run in, and the one exemption ───────────
  // The introductions part needs both personas to be members, so on its own it
  // refuses once she is outside — which is why one invocation runs it FIRST.
  const pairAfter = await loadDemoTarget(sql, { eventSlug, pair: [a.email, b.email], pepper });
  assert.equal(pairAfter.ok === false && pairAfter.code, 'refused_not_a_member');
  // …and the run that removes her membership is allowed to say so: the exemption
  // is what makes the documented restore command repeatable.
  const combined = await loadDemoTarget(sql, {
    eventSlug,
    pair: [a.email, b.email],
    pepper,
    allowNonMember: [b.email],
  });
  assert.equal(combined.ok, true, combined.ok ? '' : combined.message);

  // ── a second run is a no-op ─────────────────────────────────────────────
  const again = await loadMembershipTarget(sql, { eventSlug, email: b.email, pepper });
  assert.equal(again.ok, true);
  assert.ok(again.ok);
  assert.equal(again.value.membership, null, 'there is nothing left to remove');
  assert.deepEqual(await applyMembershipReset(sql, again.value.scope), []);
  const third = await countMembershipRows(sql, again.value.scope);
  assert.equal(isMembershipNoOp(membershipDeltas(after.scoped, third.scoped)), true);
  assert.equal(isMembershipNoOp(membershipDeltas(after.totals, third.totals)), true);
});

/**
 * …and the state she is returned to is the state the PRODUCT requires before a
 * proposal can be made: `POST /api/introductions` with an `event_id` answers
 * `403 target_not_member` while she is outside the event. That is the product
 * rule that makes the walkthrough's order (join first, propose second) the only
 * reachable one — and the reason the join step is the missing live evidence.
 */
test('demo reset: after the membership part, a proposal is refused 403 — the join is what makes the pair demonstrable', async () => {
  const { eventId, eventSlug, a, b } = await seedSpentPair('unjoin2');
  const sql = getSql();
  const pepper = process.env.HASH_PEPPER!;

  const target = await loadMembershipTarget(sql, { eventSlug, email: b.email, pepper });
  assert.ok(target.ok);
  await applyMembershipReset(sql, target.value.scope);

  const refused = await createIntroRoute(
    makeRequest('/api/introductions', {
      body: { target_profile_id: b.profileId, event_id: eventId },
      cookie: a.cookie,
    }),
  );
  assertStatus(refused, 403);
  assert.equal(((await refused.json()) as { code: string }).code, 'target_not_member');
});

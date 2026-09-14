import type { Sql, TransactionSql } from 'postgres';

/**
 * Event analytics for the organizer funnel (spec S08).
 *
 * One aggregate query set, shared by BOTH surfaces — `GET
 * /api/organizer/events/[eventId]/analytics` and the funnel block on
 * `/organizer/events/[eventId]` — so the API and the rendered numbers can never
 * drift apart.
 *
 * Privacy: every metric is a COUNT over rows of THIS event. No names, no
 * contact values, no introduction pairs, no note text. An organizer sees
 * outcomes, never participants' conversations (the product promise on
 * /organizer); the endpoint answers 403 for anyone who is not owner/admin on
 * the event's organizer.
 */

type SqlLike = Sql | TransactionSql;

export interface EventAnalytics {
  registrations_total: number;
  registrations_claimed: number;
  members_active: number;
  members_directory_visible: number;
  intros_requested: number;
  intros_mutual: number;
  intros_declined: number;
  /** Mutual introductions in this event that actually revealed >= 1 field. */
  reveals_total: number;
  /** Notes kept by active members about other active members of this event. */
  notes_created: number;
  attendance_self_reported: number;
  /** Last 30 days, oldest first, one entry per calendar day (UTC), zeros included. */
  by_day: { date: string; registrations: number; intros: number; mutual: number }[];
}

/** Window of the daily series, inclusive of today. */
export const ANALYTICS_WINDOW_DAYS = 30;

export async function loadEventAnalytics(sql: SqlLike, eventId: string): Promise<EventAnalytics> {
  const [
    registrationRows,
    claimedRows,
    memberRows,
    directoryRows,
    introRows,
    mutualRows,
    declinedRows,
    revealRows,
    noteRows,
    attendanceRows,
    byDayRows,
  ] = await Promise.all([
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM registrations WHERE event_id = ${eventId}
    `,
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM registrations
      WHERE event_id = ${eventId} AND claim_state = 'claimed'
    `,
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM event_memberships
      WHERE event_id = ${eventId} AND state = 'active'
    `,
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM event_memberships
      WHERE event_id = ${eventId} AND state = 'active' AND directory_visible = true
    `,
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM introductions WHERE event_id = ${eventId}
    `,
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM introductions
      WHERE event_id = ${eventId} AND state = 'mutual'
    `,
    // A decline is an explicit answer by the counterparty (state 'declined').
    // A withdrawal before mutual ('revoked') is NOT counted here — nothing was
    // decided about the other side.
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM introductions
      WHERE event_id = ${eventId} AND state = 'declined'
    `,
    // A "reveal" is a mutual introduction whose two sides asked to disclose at
    // least one common field — the intersection is what the participants see.
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM introductions i
      WHERE i.event_id = ${eventId}
        AND i.state = 'mutual'
        AND EXISTS (
          SELECT 1
          FROM introduction_consents a
          JOIN introduction_consents b
            ON b.introduction_id = a.introduction_id AND b.profile_id <> a.profile_id
          WHERE a.introduction_id = i.id
            AND a.profile_id IN (i.profile_a, i.profile_b)
            AND b.profile_id IN (i.profile_a, i.profile_b)
            AND a.reveal_fields && b.reveal_fields
        )
    `,
    // Notes have no event column: a note belongs to an event when BOTH sides are
    // active members of it (the same "connected" rule the notes route enforces).
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM connection_notes cn
      WHERE EXISTS (
              SELECT 1 FROM event_memberships m
              JOIN profiles p ON p.id = m.profile_id
              WHERE m.event_id = ${eventId} AND m.state = 'active' AND p.account_id = cn.owner_account_id
            )
        AND EXISTS (
              SELECT 1 FROM event_memberships m2
              WHERE m2.event_id = ${eventId} AND m2.state = 'active' AND m2.profile_id = cn.other_profile_id
            )
    `,
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM event_memberships
      WHERE event_id = ${eventId} AND attendance_source = 'self'
    `,
    sql<{ date: string; registrations: number; intros: number; mutual: number }[]>`
      WITH days AS (
        SELECT generate_series(
                 (current_date - (${ANALYTICS_WINDOW_DAYS - 1} * interval '1 day'))::date,
                 current_date,
                 interval '1 day'
               )::date AS day
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
             (SELECT count(*)::int FROM registrations r
               WHERE r.event_id = ${eventId} AND date_trunc('day', r.created_at) = d.day) AS registrations,
             (SELECT count(*)::int FROM introductions i
               WHERE i.event_id = ${eventId} AND date_trunc('day', i.created_at) = d.day) AS intros,
             (SELECT count(*)::int FROM introductions i
               WHERE i.event_id = ${eventId} AND i.state = 'mutual'
                 AND date_trunc('day', i.created_at) = d.day) AS mutual
      FROM days d
      ORDER BY d.day ASC
    `,
  ]);

  return {
    registrations_total: registrationRows[0]?.count ?? 0,
    registrations_claimed: claimedRows[0]?.count ?? 0,
    members_active: memberRows[0]?.count ?? 0,
    members_directory_visible: directoryRows[0]?.count ?? 0,
    intros_requested: introRows[0]?.count ?? 0,
    intros_mutual: mutualRows[0]?.count ?? 0,
    intros_declined: declinedRows[0]?.count ?? 0,
    reveals_total: revealRows[0]?.count ?? 0,
    notes_created: noteRows[0]?.count ?? 0,
    attendance_self_reported: attendanceRows[0]?.count ?? 0,
    by_day: byDayRows.map((r) => ({
      date: r.date,
      registrations: r.registrations,
      intros: r.intros,
      mutual: r.mutual,
    })),
  };
}

export type FunnelStepKey = 'registrations' | 'activated' | 'directory' | 'intros' | 'mutual';

export interface FunnelStep {
  key: FunnelStepKey;
  value: number;
  /** Share of the PREVIOUS step, 0..100 rounded down; null for the first step. */
  shareOfPrevious: number | null;
}

/**
 * Integer share of a previous step. `null` when the previous step is zero —
 * "0 → 3" has no meaningful percentage and the UI shows a dash instead of
 * inventing one (0% would read as "nobody", 100% as "everyone").
 */
export function conversionPercent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((part / whole) * 100)));
}

/** The five-step funnel shown as a chain: registration → activation → directory → intros → mutual. */
export function funnelSteps(analytics: EventAnalytics): FunnelStep[] {
  const chain: { key: FunnelStepKey; value: number }[] = [
    { key: 'registrations', value: analytics.registrations_total },
    { key: 'activated', value: analytics.members_active },
    { key: 'directory', value: analytics.members_directory_visible },
    { key: 'intros', value: analytics.intros_requested },
    { key: 'mutual', value: analytics.intros_mutual },
  ];
  return chain.map((step, index) => ({
    ...step,
    shareOfPrevious: index === 0 ? null : conversionPercent(step.value, chain[index - 1]!.value),
  }));
}

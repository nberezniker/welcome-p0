import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { jsonError, jsonOk, readJsonBody, internalError } from '../../../../../lib/http';
import { loadEventView } from '../../../../../lib/event-view';
import { evaluateJoinPolicy } from '../../../../../domain/events';
import { checkRateLimit } from '../../../../../lib/ratelimit';
import { recordAudit } from '../../../../../lib/audit';

/** POST /api/events/[eventIdOrSlug]/join — explicit membership join.
 * Public events join directly; closed/registration events need the event's
 * join code (or a registration claim, handled elsewhere). Creates ZERO consent
 * rows: joining is never an opt-in to any marketing. Idempotent: a repeated
 * join returns the same membership; a 'left' membership re-activates. */

const JOIN_RATE_WINDOW_MINUTES = 15;
const JOIN_RATE_MAX = 30;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ eventIdOrSlug: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { eventIdOrSlug } = await params;
    const sql = getSql();
    const view = await loadEventView(sql, eventIdOrSlug, auth.accountId);
    if (!view) return jsonError(404, 'not_found', 'Event not found');
    const eventId = view.event.id;

    const profileRows = await sql<{ id: string; offer_tags: string[]; need_tags: string[] }[]>`
      SELECT id, offer_tags, need_tags FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1
    `;
    const profile = profileRows[0];
    if (!profile) {
      return jsonError(409, 'profile_required', 'Create your profile before joining an event');
    }

    if (view.viewer.is_member) {
      return jsonOk({ ok: true, already_member: true });
    }

    const limit = await checkRateLimit(sql, {
      table: 'event_memberships',
      subjectColumn: 'profile_id',
      subjectId: profile.id,
      windowMinutes: JOIN_RATE_WINDOW_MINUTES,
      max: JOIN_RATE_MAX,
    });
    if (limit.limited) {
      return jsonError(429, 'rate_limited', 'Too many join attempts. Try again later.', {
        retryable: true,
        headers: { 'Retry-After': String(limit.retryAfterSeconds) },
      });
    }

    const body = await readJsonBody(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

    const countRows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM event_memberships WHERE event_id = ${eventId} AND state = 'active'
    `;
    const decision = evaluateJoinPolicy(
      {
        status: view.event.status,
        access_mode: view.event.access_mode ?? 'closed',
        join_code: await currentJoinCode(sql, eventId),
        max_participants: await currentMaxParticipants(sql, eventId),
        activeCount: countRows[0]?.count ?? 0,
      },
      b.join_code,
    );
    if (!decision.ok) {
      return jsonError(403, decision.code, decision.message);
    }

    const result = await sql.begin(async (tx) => {
      const existing = await tx<{ id: string; state: string }[]>`
        SELECT id, state FROM event_memberships
        WHERE event_id = ${eventId} AND profile_id = ${profile.id}
        LIMIT 1
        FOR UPDATE
      `;
      const row = existing[0];
      if (!row) {
        const created = await tx<{ id: string; state: string }[]>`
          INSERT INTO event_memberships (event_id, profile_id, offer_tags, need_tags, directory_visible, state)
          VALUES (${eventId}, ${profile.id}, ${profile.offer_tags}, ${profile.need_tags}, false, 'active')
          ON CONFLICT (event_id, profile_id) DO NOTHING
          RETURNING id, state
        `;
        if (created[0]) return { membership: created[0], joined: true };
        // Concurrent join won the race — treat as already member.
        const winner = await tx<{ id: string; state: string }[]>`
          SELECT id, state FROM event_memberships
          WHERE event_id = ${eventId} AND profile_id = ${profile.id} LIMIT 1
        `;
        return { membership: winner[0]!, joined: false };
      }
      if (row.state === 'left') {
        const revived = await tx<{ id: string; state: string }[]>`
          UPDATE event_memberships SET state = 'active'
          WHERE id = ${row.id} AND state = 'left'
          RETURNING id, state
        `;
        return { membership: revived[0] ?? row, joined: true };
      }
      return { membership: row, joined: false };
    });

    if (result.joined) {
      await recordAudit(sql, auth.accountId, 'event.joined', 'event', eventId, {
        membership_id: result.membership.id,
      });
    }

    return jsonOk({
      ok: true,
      already_member: !result.joined,
      membership: {
        id: result.membership.id,
        state: result.membership.state,
        directory_visible: false,
      },
    });
  } catch (err) {
    return internalError(err);
  }
}

/** join_code/max_participants may have changed since the view snapshot; read
 * them at decision time so the policy always sees current values. */
async function currentJoinCode(sql: ReturnType<typeof getSql>, eventId: string): Promise<string | null> {
  const rows = await sql<{ join_code: string | null }[]>`SELECT join_code FROM events WHERE id = ${eventId}`;
  return rows[0]?.join_code ?? null;
}

async function currentMaxParticipants(sql: ReturnType<typeof getSql>, eventId: string): Promise<number | null> {
  const rows = await sql<{ max_participants: number | null }[]>`SELECT max_participants FROM events WHERE id = ${eventId}`;
  return rows[0]?.max_participants ?? null;
}

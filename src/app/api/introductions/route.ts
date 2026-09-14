import { NextRequest } from 'next/server';
import { getSql } from '../../../lib/db';
import { requireAccount } from '../../../lib/auth';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../lib/http';
import { validateCreateIntroInput, canonicalPair, eventContextKey, personalContextKey } from '../../../domain/introductions';
import { scorePair } from '../../../domain/matching';
import { checkRateLimit } from '../../../lib/ratelimit';
import { recordAudit } from '../../../lib/audit';
import { appBaseUrl } from '../../../lib/env';
import { enqueueOutbox } from '../../../infra/outbox';

/** POST /api/introductions — the SESSION user requests an introduction.
 * Idempotent: a repeated request returns the canonical row, never a duplicate.
 * The initiator consents by the act of requesting: their consent row is written
 * as decision 'accept' with source 'implicit_by_initiation' in the same
 * transaction, so pending → mutual needs only the counterparty's accept
 * (ADR 0010). The initiator may still respond later — that is an explicit
 * decision and overwrites the row with source 'explicit'. */

const INTRO_RATE_WINDOW_MINUTES = 60;
const INTRO_RATE_MAX = 60;

async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = await readJsonBody(req);
    const input = validateCreateIntroInput(body);
    if (!input.ok) return jsonError(400, input.code, input.message);

    const sql = getSql();
    const myRows = await sql<{ id: string; display_name: string }[]>`
      SELECT id, display_name FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1
    `;
    const my = myRows[0];
    if (!my) return jsonError(409, 'profile_required', 'Create your profile first');

    const targetRows = await sql<{ id: string; account_id: string; status: string }[]>`
      SELECT p.id, p.account_id, a.status FROM profiles p JOIN accounts a ON a.id = p.account_id
      WHERE p.id = ${input.value.targetProfileId} LIMIT 1
    `;
    const target = targetRows[0];
    if (!target || target.status !== 'active') return jsonError(404, 'not_found', 'Target profile not found');
    if (target.id === my.id) return jsonError(400, 'self_intro', 'You cannot request an introduction with yourself');

    const pair = canonicalPair(my.id, target.id);
    const contextKey = input.value.eventId ? eventContextKey(input.value.eventId) : personalContextKey(my.id, target.id);

    // Event-context introductions require both sides to be active members.
    if (input.value.eventId) {
      const memberRows = await sql<{ profile_id: string }[]>`
        SELECT m.profile_id
        FROM event_memberships m
        WHERE m.event_id = ${input.value.eventId} AND m.state = 'active'
          AND m.profile_id IN (${my.id}, ${target.id})
      `;
      const memberIds = new Set(memberRows.map((r) => r.profile_id));
      if (!memberIds.has(my.id)) return jsonError(403, 'not_member', 'Join the event before requesting introductions');
      if (!memberIds.has(target.id)) return jsonError(403, 'target_not_member', 'The other person is not an active member of this event');
    }

    // Blocks make introductions impossible in both directions.
    const blockedRows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM blocks
      WHERE (blocker_account_id = ${auth.accountId} AND target_account_id = ${target.account_id})
         OR (blocker_account_id = ${target.account_id} AND target_account_id = ${auth.accountId})
    `;
    if ((blockedRows[0]?.count ?? 0) > 0) {
      return jsonError(403, 'blocked', 'Introduction is not available');
    }

    const limit = await checkRateLimit(sql, {
      table: 'audit_events',
      subjectColumn: 'actor_account_id',
      subjectId: auth.accountId,
      windowMinutes: INTRO_RATE_WINDOW_MINUTES,
      max: INTRO_RATE_MAX,
    });
    if (limit.limited) {
      return jsonError(429, 'rate_limited', 'Too many introduction requests. Try again later.', {
        retryable: true,
        headers: { 'Retry-After': String(limit.retryAfterSeconds) },
      });
    }

    // Fact-based reason snapshot from the pure core (empty when no mutual fit).
    const tagsFor = async (profileId: string): Promise<{ needs: string[]; offers: string[] }> => {
      if (input.value.eventId) {
        const rows = await sql<{ need_tags: string[]; offer_tags: string[] }[]>`
          SELECT COALESCE(NULLIF(m.need_tags, '{}'), pr.need_tags) AS need_tags,
                 COALESCE(NULLIF(m.offer_tags, '{}'), pr.offer_tags) AS offer_tags
          FROM profiles pr
          JOIN event_memberships m ON m.profile_id = pr.id
          WHERE pr.id = ${profileId} AND m.event_id = ${input.value.eventId}
          LIMIT 1
        `;
        if (rows[0]) return { needs: rows[0].need_tags, offers: rows[0].offer_tags };
      }
      const rows = await sql<{ need_tags: string[]; offer_tags: string[] }[]>`
        SELECT need_tags, offer_tags FROM profiles WHERE id = ${profileId} LIMIT 1
      `;
      return { needs: rows[0]?.need_tags ?? [], offers: rows[0]?.offer_tags ?? [] };
    };
    const myTags = await tagsFor(my.id);
    const targetTags = await tagsFor(target.id);
    const match = scorePair(
      { id: my.id, eligible: true, needs: myTags.needs, offers: myTags.offers },
      { id: target.id, eligible: true, needs: targetTags.needs, offers: targetTags.offers },
    );
    const reason = match
      ? { reasons_for_a: match.reasonsForA, reasons_for_b: match.reasonsForB, algorithm: match.algorithm }
      : {};

    const result = await sql.begin(async (tx) => {
      const inserted = await tx<{ id: string; state: string }[]>`
        INSERT INTO introductions (event_id, profile_a, profile_b, context_key, reason)
        VALUES (${input.value.eventId}, ${pair.profileA}, ${pair.profileB}, ${contextKey}, ${tx.json(reason)})
        ON CONFLICT (context_key, profile_a, profile_b) DO NOTHING
        RETURNING id, state
      `;
      if (inserted[0]) {
        // The initiator consents BY the act of requesting (ADR 0010): the row
        // is 'accept' + source 'implicit_by_initiation', so the counterparty's
        // single accept completes the mutual transition. Reveal still needs
        // both CURRENT reveal_fields sets to intersect, as before.
        await tx`
          INSERT INTO introduction_consents (introduction_id, profile_id, decision, reveal_fields, source, version)
          VALUES (${inserted[0].id}, ${my.id}, 'accept', ${input.value.revealFields}, 'implicit_by_initiation', 1)
          ON CONFLICT (introduction_id, profile_id) DO NOTHING
        `;
        // Audit inside the same transaction as the consent it documents: an
        // implicit consent that is not auditable must not exist (ADR 0010).
        await recordAudit(tx, auth.accountId, 'intro.consent_implicit', 'introduction', inserted[0].id, {
          initiator_profile_id: my.id,
        });
        // Transactional outbox: one service notice for the RECIPIENT. No
        // private contact values in the body — the answer lives in the web app.
        await enqueueOutbox(tx, {
          dedupeKey: `intro_requested:${inserted[0].id}:${target.account_id}`,
          kind: 'intro_requested_notice',
          subjectId: inserted[0].id,
          channel: 'telegram',
          purpose: 'service_channel',
          payload: {
            account_id: target.account_id,
            // Event context for the send-time channel decision (ADR 0011): the
            // email, when used, must come from THIS event's claimed registration.
            event_id: input.value.eventId,
            text: `WELCOME: ${my.display_name} отправил(а) вам запрос на знакомство. Ответить можно здесь: ${appBaseUrl()}`,
            enforce_consent: true,
            counterparty_account_id: auth.accountId,
          },
        });
        return { id: inserted[0].id, state: inserted[0].state, created: true };
      }
      const existing = await tx<{ id: string; state: string }[]>`
        SELECT id, state FROM introductions
        WHERE context_key = ${contextKey} AND profile_a = ${pair.profileA} AND profile_b = ${pair.profileB}
        LIMIT 1
      `;
      return { id: existing[0]!.id, state: existing[0]!.state, created: false };
    });

    if (result.created) {
      await recordAudit(sql, auth.accountId, 'intro.requested', 'introduction', result.id, {
        context: input.value.eventId ? 'event' : 'personal',
      });
    }

    return jsonOk({
      ok: true,
      introduction: { id: result.id, state: result.state, profile_a: pair.profileA, profile_b: pair.profileB, context_key: contextKey },
      already_existed: !result.created,
    });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

import { NextRequest } from 'next/server';
import type { Sql, TransactionSql } from 'postgres';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../../lib/http';
import { validateRespondInput, type ConsentSource, type IntroDecision } from '../../../../../domain/introductions';
import { recordAudit } from '../../../../../lib/audit';
import { appBaseUrl } from '../../../../../lib/env';
import { enqueueOutbox } from '../../../../../infra/outbox';

/**
 * POST /api/introductions/[id]/respond — accept / decline / withdraw.
 * Only the two parties may respond; the second party is NEVER taken from the
 * body. The initiator already consented BY requesting (ADR 0010), so accept
 * needs only the counterparty: the pending→mutual transition is a transactional
 * CAS, so a concurrent double-accept produces exactly one transition and
 * exactly one intro.mutual audit (AC-32). Withdraw before mutual → 'revoked'.
 * A decline or withdraw sends the other side one neutral notice — THAT it did
 * not happen, never WHY.
 */

async function postRoute(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { id } = await params;
    const body = await readJsonBody(req);
    const input = validateRespondInput(body);
    if (!input.ok) return jsonError(400, input.code, input.message);

    const sql = getSql();
    const myRows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1`;
    const my = myRows[0];
    if (!my) return jsonError(409, 'profile_required', 'Create your profile first');

    const result = await sql.begin(async (tx): Promise<{ code: string; state: string }> => {
      const introRows = await tx<{ id: string; profile_a: string; profile_b: string; state: string }[]>`
        SELECT id, profile_a, profile_b, state FROM introductions WHERE id = ${id} LIMIT 1 FOR UPDATE
      `;
      const intro = introRows[0];
      if (!intro) return { code: 'not_found', state: '' };
      if (intro.profile_a !== my.id && intro.profile_b !== my.id) {
        return { code: 'not_found', state: '' }; // never leak existence to non-parties
      }

      // SECURITY_TESTS #11: a block between the parties (either direction)
      // freezes the introduction — no new accept/decline/withdraw, hence no
      // new mutual transition and no new reveal after the block.
      const otherProfileId = intro.profile_a === my.id ? intro.profile_b : intro.profile_a;
      const blockedRows = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM blocks b
        JOIN profiles pme ON pme.id = ${my.id}
        JOIN profiles poth ON poth.id = ${otherProfileId}
        WHERE (b.blocker_account_id = pme.account_id AND b.target_account_id = poth.account_id)
           OR (b.blocker_account_id = poth.account_id AND b.target_account_id = pme.account_id)
      `;
      if ((blockedRows[0]?.count ?? 0) > 0) return { code: 'blocked', state: '' };

      const decision = input.value.decision;
      const current = intro.state;

      if (decision === 'decline' || decision === 'withdraw') {
        if (current !== 'pending') return { code: 'invalid_state', state: current };
        const next = decision === 'decline' ? 'declined' : 'revoked';
        const cas = await tx<{ id: string }[]>`
          UPDATE introductions SET state = ${next}
          WHERE id = ${intro.id} AND state = 'pending'
          RETURNING id
        `;
        if (!cas[0]) return { code: 'invalid_state', state: current };
        await upsertConsent(tx, intro.id, my.id, decision, input.value.revealFields);
        // The other side learns THAT it ended, never why (ADR 0010).
        await enqueueDecisionNotice(tx, intro.id, otherProfileId, auth.accountId, decision);
        return { code: 'ok', state: next };
      }

      // decision === 'accept'
      if (current !== 'pending' && current !== 'mutual') {
        return { code: 'invalid_state', state: current };
      }
      await upsertConsent(tx, intro.id, my.id, 'accept', input.value.revealFields);

      let next = current;
      if (current === 'pending') {
        // Mutual once both rows are 'accept'. The initiator's row was written
        // by the create route (implicit_by_initiation), so in practice ONE
        // accept here completes it; the count keeps the legacy two-sided rows
        // (and any explicit re-accept) correct.
        const both = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM introduction_consents
          WHERE introduction_id = ${intro.id}
            AND profile_id IN (${intro.profile_a}, ${intro.profile_b})
            AND decision = 'accept'
        `;
        if ((both[0]?.count ?? 0) === 2) {
          const cas = await tx<{ id: string }[]>`
            UPDATE introductions SET state = 'mutual'
            WHERE id = ${intro.id} AND state = 'pending'
            RETURNING id
          `;
          if (cas[0]) {
            next = 'mutual';
            // Exactly one row wins the CAS → exactly one mutual audit and
            // exactly one notice per side (outbox dedupe keys make it so).
            await recordAudit(tx, auth.accountId, 'intro.mutual', 'introduction', intro.id, {});
            await enqueueMutualNotices(tx, intro.id, intro.profile_a, intro.profile_b);
          }
        }
      }
      return { code: 'ok', state: next };
    });

    if (result.code === 'not_found') {
      return jsonError(404, 'not_found', 'Introduction not found');
    }
    if (result.code === 'blocked') {
      return jsonError(403, 'blocked', 'Introduction is not available');
    }
    if (result.code === 'invalid_state') {
      return jsonError(409, 'invalid_state', `This introduction is ${result.state}; only pending introductions can be answered`);
    }

    return jsonOk({
      ok: true,
      introduction: { id, state: result.state, my_decision: input.value.decision },
    });
  } catch (err) {
    return internalError(err);
  }
}

/**
 * Writes a party's consent row. Every /respond is by definition an explicit
 * decision, so it also clears the 'implicit_by_initiation' provenance the
 * create route may have written (ADR 0010) — a row can never keep claiming
 * "agreed by requesting" after the party has answered for themselves.
 */
async function upsertConsent(
  tx: Sql | TransactionSql,
  introductionId: string,
  profileId: string,
  decision: IntroDecision,
  revealFields: string[],
  source: ConsentSource = 'explicit',
): Promise<void> {
  await tx`
    INSERT INTO introduction_consents (introduction_id, profile_id, decision, reveal_fields, source, version)
    VALUES (${introductionId}, ${profileId}, ${decision}, ${revealFields}, ${source}, 1)
    ON CONFLICT (introduction_id, profile_id) DO UPDATE SET
      decision = EXCLUDED.decision,
      reveal_fields = EXCLUDED.reveal_fields,
      source = EXCLUDED.source,
      version = introduction_consents.version + 1,
      updated_at = now()
  `;
}

/**
 * One neutral notice to the OTHER party when an introduction ends early.
 * The body says only THAT it did not happen: no reason, no blame, no reveal
 * fields, no contact values, and not even which side answered (ADR 0010).
 * Consent / channel / block suppression stays the worker's send-time job, so a
 * recipient without service_channel consent or without a channel is suppressed
 * (`consent_revoked` / `no_channel`) rather than silently skipped here.
 */
async function enqueueDecisionNotice(
  tx: Sql | TransactionSql,
  introductionId: string,
  otherProfileId: string,
  myAccountId: string,
  decision: 'decline' | 'withdraw',
): Promise<void> {
  const rows = await tx<{ account_id: string }[]>`
    SELECT account_id FROM profiles WHERE id = ${otherProfileId} LIMIT 1
  `;
  const otherAccountId = rows[0]?.account_id;
  if (!otherAccountId) return;
  const declined = decision === 'decline';
  await enqueueOutbox(tx, {
    dedupeKey: `intro_${declined ? 'declined' : 'withdrawn'}:${introductionId}:${otherAccountId}`,
    kind: declined ? 'intro_declined_notice' : 'intro_withdrawn_notice',
    subjectId: introductionId,
    channel: 'telegram',
    purpose: 'service_channel',
    payload: {
      account_id: otherAccountId,
      text: declined ? 'WELCOME: знакомство не состоялось.' : 'WELCOME: знакомство отозвано.',
      enforce_consent: true,
      counterparty_account_id: myAccountId,
    },
  });
}

/**
 * Mutual transition: one service notice per side, enqueued in the SAME
 * transaction as the CAS win (spec 04 §7). Bodies carry a web link only —
 * no private contact values ever travel through the channel.
 */
async function enqueueMutualNotices(
  tx: Sql | TransactionSql,
  introductionId: string,
  profileA: string,
  profileB: string,
): Promise<void> {
  const accountRows = await tx<{ id: string; account_id: string }[]>`
    SELECT id, account_id FROM profiles WHERE id IN (${profileA}, ${profileB})
  `;
  const byProfile = new Map(accountRows.map((r) => [r.id, r.account_id]));
  const accountA = byProfile.get(profileA);
  const accountB = byProfile.get(profileB);
  if (!accountA || !accountB) return;
  for (const [accountId, otherAccountId] of [
    [accountA, accountB],
    [accountB, accountA],
  ] as const) {
    await enqueueOutbox(tx, {
      dedupeKey: `intro_mutual:${introductionId}:${accountId}`,
      kind: 'intro_mutual_notice',
      subjectId: introductionId,
      channel: 'telegram',
      purpose: 'service_channel',
      payload: {
        account_id: accountId,
        text: `WELCOME: знакомство состоялось! Контактные данные открылись в веб-приложении: ${appBaseUrl()}/introductions`,
        enforce_consent: true,
        counterparty_account_id: otherAccountId,
      },
    });
  }
}

export const POST = withApi(postRoute);

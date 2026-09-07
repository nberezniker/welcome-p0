import { NextRequest } from 'next/server';
import type { Sql, TransactionSql } from 'postgres';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { jsonError, jsonOk, readJsonBody, internalError } from '../../../../../lib/http';
import { validateRespondInput, type IntroDecision } from '../../../../../domain/introductions';
import { recordAudit } from '../../../../../lib/audit';

/**
 * POST /api/introductions/[id]/respond — accept / decline / withdraw.
 * Only the two parties may respond; the second party is NEVER taken from the
 * body. Accept needs BOTH parties: the pending→mutual transition is a
 * transactional CAS, so a concurrent double-accept produces exactly one
 * transition and exactly one intro.mutual audit (AC-32). Withdraw before
 * mutual → 'revoked'. A decline is never surfaced to the other side.
 */

export async function POST(
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
        return { code: 'ok', state: next };
      }

      // decision === 'accept'
      if (current !== 'pending' && current !== 'mutual') {
        return { code: 'invalid_state', state: current };
      }
      await upsertConsent(tx, intro.id, my.id, 'accept', input.value.revealFields);

      let next = current;
      if (current === 'pending') {
        // Mutual only when BOTH sides have accepted (independent, explicit).
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
            // Exactly one row wins the CAS → exactly one mutual audit.
            await recordAudit(tx, auth.accountId, 'intro.mutual', 'introduction', intro.id, {});
          }
        }
      }
      return { code: 'ok', state: next };
    });

    if (result.code === 'not_found') {
      return jsonError(404, 'not_found', 'Introduction not found');
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

async function upsertConsent(
  tx: Sql | TransactionSql,
  introductionId: string,
  profileId: string,
  decision: IntroDecision,
  revealFields: string[],
): Promise<void> {
  await tx`
    INSERT INTO introduction_consents (introduction_id, profile_id, decision, reveal_fields, version)
    VALUES (${introductionId}, ${profileId}, ${decision}, ${revealFields}, 1)
    ON CONFLICT (introduction_id, profile_id) DO UPDATE SET
      decision = EXCLUDED.decision,
      reveal_fields = EXCLUDED.reveal_fields,
      version = introduction_consents.version + 1,
      updated_at = now()
  `;
}

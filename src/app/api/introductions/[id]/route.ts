import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { withRequestContext, privateCacheHeaders, jsonError, jsonOk, internalError } from '../../../../lib/http';
import { decryptStored } from '../../../../lib/crypto';
import { requireKeyring } from '../../../../lib/env';
import type { RevealField } from '../../../../domain/introductions';

export const dynamic = 'force-dynamic';

/**
 * GET /api/introductions/[id] — per-party view.
 * - state: the TRUE state, for both parties. A decline/withdraw is no longer
 *   masked as 'pending' — the neutral decision notice already tells the other
 *   side it ended, so the card must not keep claiming "waiting for an answer".
 *   The REASON is what stays private: it is never stored, never returned and
 *   never sent (ADR 0010).
 * - my_decision: own record; other_accepted: only a boolean
 * - revealed: ONLY in mutual state, ONLY the intersection of both CURRENT
 *   consent field sets (AC-34: empty consent → empty reveal), decrypted values
 *   of the OTHER party's contact fields.
 */
/* Request scope only — a read-only GET takes no CSRF/rate-limit guard, but its
 * error bodies and log lines must still carry the request's correlation id. */
export const GET = withRequestContext(get);

async function get(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { id } = await params;
    const sql = getSql();

    const myRows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1`;
    const my = myRows[0];
    if (!my) return jsonError(404, 'not_found', 'Introduction not found');

    const introRows = await sql<{ id: string; profile_a: string; profile_b: string; state: string }[]>`
      SELECT id, profile_a, profile_b, state FROM introductions WHERE id = ${id} LIMIT 1
    `;
    const intro = introRows[0];
    if (!intro || (intro.profile_a !== my.id && intro.profile_b !== my.id)) {
      return jsonError(404, 'not_found', 'Introduction not found');
    }

    const consentRows = await sql<{ profile_id: string; decision: string; reveal_fields: string[] }[]>`
      SELECT profile_id, decision, reveal_fields FROM introduction_consents
      WHERE introduction_id = ${intro.id} AND profile_id IN (${intro.profile_a}, ${intro.profile_b})
    `;
    const mine = consentRows.find((c) => c.profile_id === my.id);
    const other = consentRows.find((c) => c.profile_id !== my.id);

    const myDecision = mine?.decision ?? 'pending';
    const otherAccepted = other?.decision === 'accept';
    // Both parties see the true state; the refusal's reason is what stays
    // private (there is none to leak — see the migration 009 / ADR 0010 note).
    const state = intro.state;

    // SECURITY_TESTS #11: a block between the parties (either direction)
    // suppresses the reveal — blocked parties never see (new) contact values.
    const otherProfileId = intro.profile_a === my.id ? intro.profile_b : intro.profile_a;
    const blockedRows = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM blocks b
      JOIN profiles pme ON pme.id = ${my.id}
      JOIN profiles poth ON poth.id = ${otherProfileId}
      WHERE (b.blocker_account_id = pme.account_id AND b.target_account_id = poth.account_id)
         OR (b.blocker_account_id = poth.account_id AND b.target_account_id = pme.account_id)
    `;
    const blocked = (blockedRows[0]?.count ?? 0) > 0;

    let revealed: Array<{ kind: string; value: string }> = [];
    if (intro.state === 'mutual' && mine && other && !blocked) {
      const mutualFields = mine.reveal_fields.filter((f) => other.reveal_fields.includes(f)) as RevealField[];
      if (mutualFields.length > 0) {
        const otherProfileId = intro.profile_a === my.id ? intro.profile_b : intro.profile_a;
        const contactRows = await sql<{ kind: string; encrypted_value: string }[]>`
          SELECT kind, encrypted_value FROM contact_fields
          WHERE profile_id = ${otherProfileId} AND kind = ANY(${mutualFields})
        `;
        const keyring = requireKeyring();
        revealed = contactRows.map((c) => ({ kind: c.kind, value: decryptStored(c.encrypted_value, keyring) }));
      }
    }

    return jsonOk(
      {
        ok: true,
        introduction: {
          id: intro.id,
          state,
          my_decision: myDecision,
          other_accepted: otherAccepted,
        },
        revealed,
      },
      { headers: privateCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

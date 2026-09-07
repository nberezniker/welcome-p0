import { NextRequest } from 'next/server';
import { getSql } from '../../../lib/db';
import { requireAccount } from '../../../lib/auth';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../lib/http';
import { recordAudit } from '../../../lib/audit';

/** POST /api/blocks — blocks another account. Suppression is symmetric:
 * neither side sees the other in directory/recommendations, and introductions
 * between them are impossible. The target is never told. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = await readJsonBody(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const target = b.target_account_id;
    if (typeof target !== 'string' || !UUID_RE.test(target)) {
      return jsonError(400, 'invalid_target', 'target_account_id must be an account uuid');
    }
    if (target === auth.accountId) {
      return jsonError(400, 'self_block', 'You cannot block yourself');
    }

    const sql = getSql();
    const exists = await sql<{ id: string }[]>`SELECT id FROM accounts WHERE id = ${target} LIMIT 1`;
    if (!exists[0]) return jsonError(404, 'not_found', 'Account not found');

    const inserted = await sql`
      INSERT INTO blocks (blocker_account_id, target_account_id)
      VALUES (${auth.accountId}, ${target})
      ON CONFLICT (blocker_account_id, target_account_id) DO NOTHING
      RETURNING created_at
    `;

    if (inserted.length > 0) {
      await recordAudit(sql, auth.accountId, 'block.created', 'account', target, {});
    }

    return jsonOk({ ok: true, already_blocked: inserted.length === 0 });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

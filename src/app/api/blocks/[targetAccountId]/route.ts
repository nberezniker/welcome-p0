import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { jsonError, jsonOk, internalError } from '../../../../lib/http';
import { recordAudit } from '../../../../lib/audit';

/** DELETE /api/blocks/[targetAccountId] — removes the caller's block,
 * restoring mutual visibility and the ability to interact again. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ targetAccountId: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { targetAccountId } = await params;
    if (!UUID_RE.test(targetAccountId)) {
      return jsonError(400, 'invalid_target', 'targetAccountId must be an account uuid');
    }

    const sql = getSql();
    const deleted = await sql`
      DELETE FROM blocks
      WHERE blocker_account_id = ${auth.accountId} AND target_account_id = ${targetAccountId}
      RETURNING target_account_id
    `;

    if (deleted.length > 0) {
      await recordAudit(sql, auth.accountId, 'block.removed', 'account', targetAccountId, {});
    }

    return jsonOk({ ok: true, was_blocked: deleted.length > 0 });
  } catch (err) {
    return internalError(err);
  }
}

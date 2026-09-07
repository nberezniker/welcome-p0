import { NextRequest } from 'next/server';
import { getSql } from '../../../lib/db';
import { requireAccount } from '../../../lib/auth';
import { asString, internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../lib/http';
import { recordAudit } from '../../../lib/audit';
import { suppressJobsForAccountChannel } from '../../../infra/outbox';

/**
 * DELETE /api/me — account self-deletion (double confirmation happens in the
 * UI; the API still requires the profile display name as the typed confirm).
 * Soft-deletes: status='deleting' signs the account out everywhere and
 * disables the public card; email lookup is released; queued channel sends
 * are suppressed. Named by the Phase-4 brief; listed as a new endpoint.
 */
async function deleteRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const confirm = asString(body?.['confirm'], { maxLength: 200 });
    if (!confirm) return jsonError(400, 'confirm_required', 'Type your display name to confirm deletion');

    const sql = getSql();
    const profileRows = await sql<{ display_name: string }[]>`
      SELECT display_name FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1`;
    const expected = profileRows[0]?.display_name ?? 'DELETE';
    if (confirm !== expected) {
      return jsonError(400, 'confirm_mismatch', 'The typed name does not match');
    }

    await sql.begin(async (tx) => {
      await tx`
        UPDATE accounts
        SET status = 'deleting',
            auth_subject = 'deleted:' || id::text,
            email_lookup_hash = NULL,
            updated_at = now()
        WHERE id = ${auth.accountId}`;
      await tx`DELETE FROM sessions WHERE account_id = ${auth.accountId}`;
      await recordAudit(tx, auth.accountId, 'account.delete_requested', 'account', auth.accountId, {
        via: 'web',
      });
      await suppressJobsForAccountChannel(tx, auth.accountId, 'telegram', 'account_deleted');
    });

    return jsonOk({ ok: true, deleted: true });
  } catch (err) {
    return internalError(err);
  }
}

export const DELETE = withApi(deleteRoute);

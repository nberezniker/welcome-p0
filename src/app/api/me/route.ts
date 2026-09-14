import { NextRequest } from 'next/server';
import { getSql } from '../../../lib/db';
import { requireAccount } from '../../../lib/auth';
import {
  asString,
  internalError,
  jsonError,
  jsonOk,
  privateCacheHeaders,
  readJsonBody,
  withApi,
} from '../../../lib/http';
import { recordAudit } from '../../../lib/audit';
import { suppressJobsForAccountChannel } from '../../../infra/outbox';

/**
 * GET /api/me — thin, secretless summary of the signed-in caller's account.
 *
 * Added for the usage-matrix deviation list: the brief names `GET /api/me`, but
 * only DELETE existed, so a client had to compose four reads to answer "who am
 * I and do I have a profile yet". Deliberately minimal and owner-only:
 *   - identity fields (id, status, created_at, is_demo — the caller's own row);
 *   - profile presence + the two values that are already public (public_slug,
 *     display_name);
 *   - NEVER the login email (only its keyed hash is stored), no hashes, no
 *     tokens, no consent/security internals.
 * `no-store` like every other private read (P5).
 */
async function getRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const sql = getSql();
    const rows = await sql<{
      id: string;
      status: string;
      created_at: Date;
      is_demo: boolean;
      public_slug: string | null;
      display_name: string | null;
    }[]>`
      SELECT a.id, a.status, a.created_at, a.is_demo, p.public_slug, p.display_name
      FROM accounts a
      LEFT JOIN profiles p ON p.account_id = a.id
      WHERE a.id = ${auth.accountId}
      LIMIT 1
    `;
    const row = rows[0];
    // Session valid but the row is gone (purged between the two reads).
    if (!row) return jsonError(401, 'unauthorized', 'Sign in required');

    return jsonOk(
      {
        ok: true,
        account: {
          id: row.id,
          status: row.status,
          created_at: row.created_at.toISOString(),
          is_demo: row.is_demo,
          has_profile: row.public_slug !== null,
          public_slug: row.public_slug,
          display_name: row.display_name,
        },
      },
      { headers: privateCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

export const GET = getRoute;

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

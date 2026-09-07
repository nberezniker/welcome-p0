import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { jsonError, jsonOk, internalError } from '../../../../lib/http';
import { recordAudit } from '../../../../lib/audit';
import { suppressJobsForAccountChannel } from '../../../../infra/outbox';

/**
 * DELETE /api/channels/telegram — unlink the active Telegram binding from the
 * web app (mirror of the bot's /stop). Phase-4 UI needs this for the unlink
 * button on /me/telegram; kept minimal and listed in the phase report.
 */
export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const sql = getSql();
    const result = await sql.begin(async (tx) => {
      const updated = await tx<{ id: string }[]>`
        UPDATE channel_bindings SET state = 'revoked'
        WHERE account_id = ${auth.accountId} AND provider = 'telegram' AND state = 'active'
        RETURNING id
      `;
      await recordAudit(tx, auth.accountId, 'channel.revoked', 'channel_binding', updated[0]?.id ?? null, {
        provider: 'telegram',
        via: 'web',
      });
      await suppressJobsForAccountChannel(tx, auth.accountId, 'telegram', 'channel_revoked');
      return updated.length;
    });

    return jsonOk({ ok: true, unlinked: result > 0 });
  } catch (err) {
    return internalError(err);
  }
}

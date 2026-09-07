import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { asString, internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../../lib/http';
import { hashSessionToken } from '../../../../../lib/crypto';
import { recordAudit } from '../../../../../lib/audit';

/**
 * POST /api/channels/telegram/confirm {token} — web-side confirmation of the
 * two-sided binding (AC-11). Must be called from the SAME authenticated web
 * session that created the challenge. Only when this flag is set AND the bot
 * receives /start with the same token does the binding complete.
 */
async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
    const token = asString(body?.['token'], { maxLength: 512 });
    if (!token) return jsonError(400, 'invalid_token', 'token is required');

    const sql = getSql();
    const tokenHash = hashSessionToken(token);
    const rows = await sql<{ id: string }[]>`
      UPDATE link_challenges
      SET proof_flags = proof_flags || '{"web_confirmed": true}'::jsonb
      WHERE token_hash = ${tokenHash} AND purpose = 'telegram_link'
        AND consumed_at IS NULL AND expires_at > now()
        AND account_id = ${auth.accountId}
      RETURNING id
    `;
    if (!rows[0]) {
      // 404 — never reveal whether the token exists for someone else.
      return jsonError(404, 'challenge_not_found', 'No pending Telegram link challenge for this session');
    }

    await recordAudit(sql, auth.accountId, 'channel.web_confirmed', 'link_challenge', rows[0].id, {
      provider: 'telegram',
    });
    return jsonOk({
      ok: true,
      challenge_id: rows[0].id,
      next: 'Open the deep link in Telegram and send /start to finish binding.',
    });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

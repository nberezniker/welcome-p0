import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { jsonError, jsonOk, internalError } from '../../../../../lib/http';
import { hashSessionToken } from '../../../../../lib/crypto';
import { challengeTtlMinutes } from '../../../../../domain/challenges';
import { telegramBotUsername } from '../../../../../integrations/telegram';

/**
 * POST /api/channels/telegram/challenge — authenticated first step of the
 * two-sided Telegram binding (AC-11).
 *
 * Creates a telegram_link challenge: token ≥128-bit (256-bit here), only its
 * SHA-256 hash is stored, TTL 10 minutes, bound to the SESSION account.
 * The deep link alone proves nothing — the same challenge must also be
 * confirmed from this web session (POST /api/channels/telegram/confirm) and
 * then presented to the bot via /start. A stolen token without the web-side
 * confirmation can never create a binding.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const token = randomBytes(32).toString('base64url'); // 256-bit
    const ttlMinutes = challengeTtlMinutes('telegram_link');
    const sql = getSql();
    const rows = await sql<{ id: string; expires_at: Date }[]>`
      INSERT INTO link_challenges (account_id, purpose, token_hash, expires_at)
      VALUES (${auth.accountId}, 'telegram_link', ${hashSessionToken(token)}, now() + (${ttlMinutes} * interval '1 minute'))
      RETURNING id, expires_at
    `;
    const row = rows[0];
    if (!row) return internalError(new Error('challenge insert returned no row'));

    const deepLink = `https://t.me/${telegramBotUsername()}?start=link_${token}`;
    return jsonOk(
      {
        ok: true,
        challenge: { id: row.id, expires_at: new Date(row.expires_at).toISOString() },
        deep_link: deepLink,
        next: 'Confirm the link in this web session, then send /start with the link in Telegram.',
      },
      { status: 201 },
    );
  } catch (err) {
    return internalError(err);
  }
}

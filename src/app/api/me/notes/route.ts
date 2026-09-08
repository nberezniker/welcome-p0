import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { privateCacheHeaders, jsonError, jsonOk, internalError } from '../../../../lib/http';

export const dynamic = 'force-dynamic';

/** GET /api/me/notes — the owner's private connection notes and next steps.
 * These records are NEVER exposed to the other party, organizers or exports. */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const sql = getSql();
    const rows = await sql<
      { other_profile_id: string; note_text: string | null; next_step: string | null; next_step_status: string; updated_at: Date }[]
    >`
      SELECT other_profile_id, note_text, next_step, next_step_status, updated_at
      FROM connection_notes
      WHERE owner_account_id = ${auth.accountId}
      ORDER BY updated_at DESC
    `;

    return jsonOk({ ok: true, notes: rows }, { headers: privateCacheHeaders() });
  } catch (err) {
    return internalError(err);
  }
}

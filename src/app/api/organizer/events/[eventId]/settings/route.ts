import { NextRequest } from 'next/server';
import type { Sql } from 'postgres';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../../../lib/http';
import { requireEventRole } from '../../../../../../domain/organizer';
import { EVENT_ACCESS_MODES, JOIN_CODE_MAX, JOIN_CODE_MIN, isValidJoinCode } from '../../../../../../domain/events';
import { recordAudit } from '../../../../../../lib/audit';

/** Settings the owner/admin may change on an event. Join code bounds live in
 * the events domain (F-02: min raised 4→8). */

function isIsoDateTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}/.test(value.trim());
}

/** POST /api/organizer/events/[eventId]/settings — owner/admin only.
 * Body (all optional): { join_code: string|null, access_mode, directory_close_at: string|null }. */
async function postRoute(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { eventId } = await params;
    const sql: Sql = getSql();
    const role = await requireEventRole(sql, auth.accountId, eventId, ['owner', 'admin']);
    if (!role) return jsonError(403, 'forbidden', 'You do not manage this event');

    const body = await readJsonBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return jsonError(400, 'invalid_body', 'JSON object expected');
    }
    const b = body as Record<string, unknown>;

    let joinCode: string | null | undefined;
    if ('join_code' in b) {
      if (b.join_code === null) {
        joinCode = null;
      } else if (typeof b.join_code === 'string') {
        const code = b.join_code.trim();
        if (!isValidJoinCode(code)) {
          return jsonError(400, 'invalid_join_code', `join_code must be ${JOIN_CODE_MIN}..${JOIN_CODE_MAX} chars, or null to clear`);
        }
        joinCode = code;
      } else {
        return jsonError(400, 'invalid_join_code', 'join_code must be a string or null');
      }
    }

    let accessMode: string | undefined;
    if ('access_mode' in b) {
      if (typeof b.access_mode !== 'string' || !(EVENT_ACCESS_MODES as readonly string[]).includes(b.access_mode)) {
        return jsonError(400, 'invalid_access_mode', `access_mode must be one of: ${EVENT_ACCESS_MODES.join(', ')}`);
      }
      accessMode = b.access_mode;
    }

    let directoryCloseAt: Date | null | undefined;
    if ('directory_close_at' in b) {
      if (b.directory_close_at === null) {
        directoryCloseAt = null;
      } else if (typeof b.directory_close_at === 'string' && isIsoDateTime(b.directory_close_at)) {
        directoryCloseAt = new Date(b.directory_close_at);
      } else {
        return jsonError(400, 'invalid_directory_close_at', 'directory_close_at must be an ISO 8601 timestamp or null');
      }
    }

    if (joinCode === undefined && accessMode === undefined && directoryCloseAt === undefined) {
      return jsonError(400, 'nothing_to_update', 'Provide join_code, access_mode and/or directory_close_at');
    }

    const row = await sql.begin(async (tx) => {
      if (joinCode !== undefined) {
        await tx`UPDATE events SET join_code = ${joinCode} WHERE id = ${eventId}`;
      }
      if (accessMode !== undefined) {
        await tx`UPDATE events SET access_mode = ${accessMode} WHERE id = ${eventId}`;
      }
      if (directoryCloseAt !== undefined) {
        await tx`UPDATE events SET directory_close_at = ${directoryCloseAt} WHERE id = ${eventId}`;
      }
      const rows = await tx<{ id: string; slug: string; access_mode: string | null; join_code: string | null; directory_close_at: Date | null }[]>`
        SELECT id, slug, access_mode, join_code, directory_close_at FROM events WHERE id = ${eventId}
      `;
      return rows[0];
    });
    if (!row) return jsonError(404, 'not_found', 'Event not found');

    await recordAudit(sql, auth.accountId, 'event.settings_updated', 'event', eventId, {
      join_code_changed: joinCode !== undefined,
      access_mode: row.access_mode,
      directory_close_at_changed: directoryCloseAt !== undefined,
    });

    return jsonOk({
      ok: true,
      settings: {
        access_mode: row.access_mode,
        join_code_set: row.join_code !== null,
        directory_close_at: row.directory_close_at,
      },
    });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

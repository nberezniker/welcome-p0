import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { asString, internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../../lib/http';
import { recordAudit } from '../../../../../lib/audit';

/** PUT /api/me/notes/[otherProfileId] — upsert the owner's private note about
 * another person. Only possible when the two accounts are actually connected:
 * a shared ACTIVE event membership or an existing introduction. An organizer
 * who never joined cannot attach (and never see) participant notes (AC-35). */

const NOTE_MAX = 5000;
const NEXT_STEP_MAX = 500;
const STEP_STATUSES = ['none', 'proposed', 'confirmed', 'done', 'dropped'] as const;

async function putRoute(
  req: NextRequest,
  { params }: { params: Promise<{ otherProfileId: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { otherProfileId } = await params;
    const sql = getSql();

    const otherRows = await sql<{ id: string; account_id: string }[]>`
      SELECT p.id, p.account_id FROM profiles p
      JOIN accounts a ON a.id = p.account_id
      WHERE p.id = ${otherProfileId} AND a.status = 'active'
      LIMIT 1
    `;
    const other = otherRows[0];
    if (!other) return jsonError(404, 'not_found', 'Profile not found');
    if (other.account_id === auth.accountId) {
      return jsonError(400, 'self_note', 'Notes are about other people');
    }

    // Connected = shared active membership OR an existing introduction pair.
    const connected = await sql<{ count: number }[]>`
      SELECT (
        (SELECT count(*)::int FROM event_memberships ma
          JOIN event_memberships mb ON mb.event_id = ma.event_id
          JOIN profiles pa ON pa.id = ma.profile_id
          JOIN profiles pb ON pb.id = mb.profile_id
          WHERE pa.account_id = ${auth.accountId} AND pb.account_id = ${other.account_id}
            AND ma.state = 'active' AND mb.state = 'active')
        + (SELECT count(*)::int FROM introductions i
          JOIN profiles pa ON pa.id = i.profile_a
          JOIN profiles pb ON pb.id = i.profile_b
          WHERE pa.account_id = ${auth.accountId} AND pb.account_id = ${other.account_id})
      )::int AS count
    `;
    if ((connected[0]?.count ?? 0) === 0) {
      return jsonError(403, 'not_connected', 'Notes can only be kept about people you actually met');
    }

    const body = await readJsonBody(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

    const hasNote = 'note_text' in b;
    const hasStep = 'next_step' in b;
    const hasStatus = 'next_step_status' in b;
    if (!hasNote && !hasStep && !hasStatus) {
      return jsonError(400, 'nothing_to_update', 'Provide note_text, next_step and/or next_step_status');
    }

    // Omitted fields keep their stored value on upsert (no accidental erasure).
    let noteText: string | null = null;
    if (hasNote) {
      if (b.note_text === null) {
        noteText = null;
      } else {
        const v = asString(b.note_text, { maxLength: NOTE_MAX, minLength: 1 });
        if (!v) return jsonError(400, 'invalid_note_text', `note_text must be 1..${NOTE_MAX} chars`);
        noteText = v;
      }
    }
    let nextStep: string | null = null;
    if (hasStep) {
      if (b.next_step === null) {
        nextStep = null;
      } else {
        const v = asString(b.next_step, { maxLength: NEXT_STEP_MAX, minLength: 1 });
        if (!v) return jsonError(400, 'invalid_next_step', `next_step must be 1..${NEXT_STEP_MAX} chars`);
        nextStep = v;
      }
    }

    let nextStepStatus: string | undefined;
    if (hasStatus) {
      if (typeof b.next_step_status !== 'string' || !(STEP_STATUSES as readonly string[]).includes(b.next_step_status)) {
        return jsonError(400, 'invalid_next_step_status', `next_step_status must be one of: ${STEP_STATUSES.join(', ')}`);
      }
      nextStepStatus = b.next_step_status;
    }

    const noteSet = hasNote ? sql`note_text = ${noteText}` : sql`note_text = connection_notes.note_text`;
    const stepSet = hasStep ? sql`next_step = ${nextStep}` : sql`next_step = connection_notes.next_step`;
    const statusSet = hasStatus && nextStepStatus !== undefined
      ? sql`next_step_status = ${nextStepStatus}`
      : sql`next_step_status = connection_notes.next_step_status`;

    const rows = await sql`
      INSERT INTO connection_notes (owner_account_id, other_profile_id, note_text, next_step, next_step_status)
      VALUES (${auth.accountId}, ${other.id}, ${noteText}, ${nextStep}, ${nextStepStatus ?? 'none'})
      ON CONFLICT (owner_account_id, other_profile_id) DO UPDATE SET
        ${noteSet}, ${stepSet}, ${statusSet},
        updated_at = now()
      RETURNING other_profile_id, note_text, next_step, next_step_status, updated_at
    `;

    await recordAudit(sql, auth.accountId, 'note.saved', 'profile', other.id, {});

    return jsonOk({ ok: true, note: rows[0] });
  } catch (err) {
    return internalError(err);
  }
}

export const PUT = withApi(putRoute);

import type { Sql, TransactionSql } from 'postgres';

/** Own-membership resolution for /api/me/memberships/*.
 * A member may only change their OWN membership; anything else is 403. */

export interface OwnMembership {
  id: string;
  event_id: string;
  profile_id: string;
  state: string;
  directory_visible: boolean;
  attendance_source: string;
  offer_tags: string[];
  need_tags: string[];
}

export async function requireOwnMembership(
  sql: Sql | TransactionSql,
  accountId: string,
  membershipId: string,
): Promise<OwnMembership | null> {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(membershipId) || !uuidRe.test(accountId)) return null;
  const rows = await sql<OwnMembership[]>`
    SELECT m.id, m.event_id, m.profile_id, m.state, m.directory_visible, m.attendance_source,
           m.offer_tags, m.need_tags
    FROM event_memberships m
    JOIN profiles p ON p.id = m.profile_id
    WHERE m.id = ${membershipId} AND p.account_id = ${accountId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface MembershipPatchInput {
  directoryVisible?: boolean;
  offerTags?: string[];
  needTags?: string[];
  leave?: boolean;
}

export type MembershipPatchValidation =
  | { ok: true; value: MembershipPatchInput }
  | { ok: false; code: string; message: string };

/** Validates a PATCH body: directory_visible (bool), offer_tags/need_tags (tag
 * arrays), state (only 'left' — re-joining happens via the join endpoint). */
export function validateMembershipPatch(body: unknown): MembershipPatchValidation {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;
  const value: MembershipPatchInput = {};

  if ('directory_visible' in b) {
    if (typeof b.directory_visible !== 'boolean') {
      return { ok: false, code: 'invalid_directory_visible', message: 'directory_visible must be a boolean' };
    }
    value.directoryVisible = b.directory_visible;
  }

  for (const [key, target] of [['offer_tags', 'offerTags'], ['need_tags', 'needTags']] as const) {
    if (key in b) {
      const raw = b[key];
      if (!Array.isArray(raw) || raw.some((t) => typeof t !== 'string' || t.length > 80) || raw.length > 30) {
        return { ok: false, code: `invalid_${key}`, message: `${key} must be an array of short strings (max 30)` };
      }
      value[target] = (raw as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
  }

  if ('state' in b) {
    if (b.state !== 'left') {
      return { ok: false, code: 'invalid_state', message: "state may only be set to 'left'; re-join via the join endpoint" };
    }
    value.leave = true;
  }

  if (value.directoryVisible === undefined && value.offerTags === undefined && value.needTags === undefined && !value.leave) {
    return { ok: false, code: 'nothing_to_update', message: 'Provide directory_visible, offer_tags, need_tags and/or state' };
  }

  return { ok: true, value };
}

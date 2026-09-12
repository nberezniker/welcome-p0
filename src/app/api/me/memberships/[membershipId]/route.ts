import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../../lib/http';
import { requireOwnMembership, validateMembershipPatch } from '../../../../../domain/membership';
import { recordAudit } from '../../../../../lib/audit';

/** PATCH /api/me/memberships/[membershipId] — the member updates their OWN
 * membership: directory visibility, per-event tag overrides, or leaving.
 * Organizer approval is never involved; state accepts only 'left'. */
async function patchRoute(
  req: NextRequest,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { membershipId } = await params;
    const sql = getSql();
    const membership = await requireOwnMembership(sql, auth.accountId, membershipId);
    if (!membership) return jsonError(403, 'forbidden', 'This membership does not belong to you');

    const body = await readJsonBody(req);
    const input = validateMembershipPatch(body);
    if (!input.ok) return jsonError(400, input.code, input.message);

    const rows = await sql<{ id: string; event_id: string; state: string; directory_visible: boolean; matching_enabled: boolean; offer_tags: string[]; need_tags: string[]; need_intents: string[]; offer_intents: string[]; interests: string[]; industry: string | null; job_function: string | null; keywords: string[] }[]>`
      UPDATE event_memberships SET
        directory_visible = ${input.value.directoryVisible ?? membership.directory_visible},
        matching_enabled = ${input.value.matchingEnabled ?? membership.matching_enabled},
        offer_tags = ${input.value.offerTags ?? membership.offer_tags},
        need_tags = ${input.value.needTags ?? membership.need_tags},
        need_intents = ${input.value.needIntents ?? membership.need_intents},
        offer_intents = ${input.value.offerIntents ?? membership.offer_intents},
        interests = ${input.value.interests ?? membership.interests},
        industry = ${input.value.industry !== undefined ? input.value.industry : membership.industry},
        job_function = ${input.value.jobFunction !== undefined ? input.value.jobFunction : membership.job_function},
        keywords = ${input.value.keywords ?? membership.keywords},
        state = ${input.value.leave ? 'left' : membership.state}
      WHERE id = ${membership.id}
      RETURNING id, event_id, state, directory_visible, matching_enabled, offer_tags, need_tags,
                need_intents, offer_intents, interests, industry, job_function, keywords
    `;
    const row = rows[0]!;

    if (input.value.leave && membership.state !== 'left') {
      await recordAudit(sql, auth.accountId, 'membership.left', 'membership', membership.id, {
        event_id: membership.event_id,
      });
    }

    return jsonOk({ ok: true, membership: row });
  } catch (err) {
    return internalError(err);
  }
}

export const PATCH = withApi(patchRoute);

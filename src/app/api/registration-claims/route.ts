import { NextRequest } from 'next/server';
import { getSql } from '../../../lib/db';
import { requireAccount } from '../../../lib/auth';
import { jsonError, jsonOk, readJsonBody, asString, internalError } from '../../../lib/http';
import { hashSessionToken, generatePublicSlug } from '../../../lib/crypto';
import { recordAudit } from '../../../lib/audit';

/** POST /api/registration-claims — binds an unclaimed imported registration to
 * the AUTHENTICATED account after proving the registration's email (AC-08).
 * The challenge is consumed atomically (CAS), so a replay gets 409 (AC-09).
 * A missing profile is created from the imported name; an existing profile is
 * NEVER mutated (AC-18). No consent rows are implied by claiming. */

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = await readJsonBody(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const token = asString(b.token, { maxLength: 200 });
    if (!token) return jsonError(400, 'invalid_token', 'token is required');

    const sql = getSql();
    const tokenHash = hashSessionToken(token);

    const challengeRows = await sql<{ id: string; expires_at: Date; consumed_at: Date | null; registration_id: string | null }[]>`
      SELECT id, expires_at, consumed_at, registration_id
      FROM link_challenges
      WHERE token_hash = ${tokenHash} AND purpose = 'registration_claim'
      LIMIT 1
    `;
    const challenge = challengeRows[0];
    if (!challenge || !challenge.registration_id) {
      return jsonError(404, 'not_found', 'Claim link is unknown');
    }
    if (challenge.consumed_at) {
      return jsonError(409, 'already_used', 'This claim link has already been used');
    }
    if (new Date(challenge.expires_at).getTime() <= Date.now()) {
      return jsonError(410, 'expired', 'This claim link has expired');
    }

    const regRows = await sql<{
      id: string; event_id: string; email_lookup_hash: string | null; imported_name: string | null; claim_state: string; approval_status: string;
    }[]>`
      SELECT id, event_id, email_lookup_hash, imported_name, claim_state, approval_status
      FROM registrations WHERE id = ${challenge.registration_id} LIMIT 1
    `;
    const registration = regRows[0];
    if (!registration) return jsonError(404, 'not_found', 'Registration not found');

    if (registration.approval_status === 'quarantined') {
      return jsonError(403, 'claim_not_allowed', 'This registration is quarantined and cannot be claimed');
    }

    // AC-08: only the account whose email matches the registration may claim.
    const accountRows = await sql<{ email_lookup_hash: string | null }[]>`
      SELECT email_lookup_hash FROM accounts WHERE id = ${auth.accountId} LIMIT 1
    `;
    const accountHash = accountRows[0]?.email_lookup_hash ?? null;
    if (!accountHash || accountHash !== registration.email_lookup_hash) {
      return jsonError(403, 'email_mismatch', 'This claim link belongs to a different email address');
    }

    if (registration.claim_state !== 'unclaimed') {
      return jsonError(409, 'already_used', 'This registration has already been claimed');
    }

    const result = await sql.begin(async (tx) => {
      // CAS consume: exactly one claim request wins.
      const consumed = await tx<{ id: string }[]>`
        UPDATE link_challenges SET consumed_at = now()
        WHERE id = ${challenge.id} AND consumed_at IS NULL AND expires_at > now()
        RETURNING id
      `;
      if (!consumed[0]) return { code: 'already_used' as const };

      const claimed = await tx<{ id: string }[]>`
        UPDATE registrations SET claim_state = 'claimed'
        WHERE id = ${registration.id} AND claim_state = 'unclaimed'
        RETURNING id
      `;
      if (!claimed[0]) return { code: 'already_used' as const };

      // Profile: create from imported data ONLY when the account has none (AC-18).
      const profileRows = await tx<{ id: string }[]>`
        SELECT id FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1
      `;
      let profileCreated = false;
      let profileId = profileRows[0]?.id ?? null;
      if (!profileId) {
        const displayName = registration.imported_name ?? 'Участник';
        const inserted = await tx<{ id: string }[]>`
          INSERT INTO profiles (account_id, public_slug, display_name)
          VALUES (${auth.accountId}, ${generatePublicSlug()}, ${displayName})
          RETURNING id
        `;
        profileId = inserted[0]!.id;
        profileCreated = true;
      }

      // Membership: create or re-activate; always directory-invisible by default.
      const existingMembership = await tx<{ id: string; state: string }[]>`
        SELECT id, state FROM event_memberships
        WHERE event_id = ${registration.event_id} AND profile_id = ${profileId}
        LIMIT 1
        FOR UPDATE
      `;
      let membershipId: string;
      let membershipState: string;
      const existing = existingMembership[0];
      if (!existing) {
        const inserted = await tx<{ id: string; state: string }[]>`
          INSERT INTO event_memberships (event_id, profile_id, registration_id, directory_visible, state)
          VALUES (${registration.event_id}, ${profileId}, ${registration.id}, false, 'active')
          RETURNING id, state
        `;
        membershipId = inserted[0]!.id;
        membershipState = inserted[0]!.state;
      } else if (existing.state === 'left') {
        const revived = await tx<{ id: string; state: string }[]>`
          UPDATE event_memberships SET state = 'active', registration_id = ${registration.id}
          WHERE id = ${existing.id} AND state = 'left'
          RETURNING id, state
        `;
        membershipId = revived[0]!.id;
        membershipState = revived[0]!.state;
      } else {
        membershipId = existing.id;
        membershipState = existing.state;
      }

      return { code: 'ok' as const, membershipId, membershipState, profileCreated };
    });

    if (result.code !== 'ok') {
      return jsonError(409, result.code, 'This claim link has already been used');
    }

    await recordAudit(sql, auth.accountId, 'registration.claimed', 'registration', registration.id, {
      event_id: registration.event_id,
      profile_created: result.profileCreated,
    });

    return jsonOk({
      ok: true,
      event_id: registration.event_id,
      membership: {
        id: result.membershipId,
        state: result.membershipState,
        directory_visible: false,
      },
      profile_created: result.profileCreated,
      // Honest framing: imported fields are unverified until the user confirms them.
      notice: 'Данные из регистрации — проверьте, что всё верно. Имя и роль можно поправить в профиле.',
    });
  } catch (err) {
    return internalError(err);
  }
}

import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../../../lib/db';
import { requireAccount } from '../../../../../../../../lib/auth';
import { internalError, jsonError, jsonOk, withApi } from '../../../../../../../../lib/http';
import { requireEventRole } from '../../../../../../../../domain/organizer';
import { challengeTtlMinutes } from '../../../../../../../../domain/challenges';
import { generateSessionToken, hashSessionToken } from '../../../../../../../../lib/crypto';
import { checkRateLimit } from '../../../../../../../../lib/ratelimit';
import { recordAudit } from '../../../../../../../../lib/audit';

/** POST /api/organizer/events/[eventId]/registrations/[registrationId]/invite
 * Creates a one-time registration-claim challenge. The token is returned once
 * and stored only as a SHA-256 hash. The challenge is NOT bound to any account:
 * the claiming session must prove the registration's email (AC-08).
 * ADR ①: claim links live 7 days (registration horizon), not 10 minutes. */

const INVITE_RATE_WINDOW_MINUTES = 60;
const INVITE_RATE_MAX = 200;

async function postRoute(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string; registrationId: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { eventId, registrationId } = await params;
    const sql = getSql();
    const role = await requireEventRole(sql, auth.accountId, eventId, ['owner', 'admin']);
    if (!role) return jsonError(403, 'forbidden', 'You do not manage this event');

    const regRows = await sql<{ id: string; approval_status: string; claim_state: string }[]>`
      SELECT id, approval_status, claim_state
      FROM registrations
      WHERE id = ${registrationId}::uuid AND event_id = ${eventId}::uuid
      LIMIT 1
    `;
    const registration = regRows[0];
    if (!registration) return jsonError(404, 'not_found', 'Registration not found');
    if (registration.approval_status === 'quarantined') {
      return jsonError(403, 'claim_not_allowed', 'Quarantined registrations cannot be invited');
    }
    if (registration.claim_state !== 'unclaimed') {
      return jsonError(409, 'already_claimed', 'This registration has already been claimed');
    }

    const limit = await checkRateLimit(sql, {
      table: 'audit_events',
      subjectColumn: 'actor_account_id',
      subjectId: auth.accountId,
      windowMinutes: INVITE_RATE_WINDOW_MINUTES,
      max: INVITE_RATE_MAX,
    });
    if (limit.limited) {
      return jsonError(429, 'rate_limited', 'Too many invites. Try again later.', {
        retryable: true,
        headers: { 'Retry-After': String(limit.retryAfterSeconds) },
      });
    }

    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const ttlMinutes = challengeTtlMinutes('registration_claim');

    const inserted = await sql<{ expires_at: Date }[]>`
      INSERT INTO link_challenges (account_id, purpose, token_hash, expires_at, registration_id)
      VALUES (NULL, 'registration_claim', ${tokenHash}, now() + (${ttlMinutes} * interval '1 minute'), ${registration.id})
      RETURNING expires_at
    `;

    await recordAudit(sql, auth.accountId, 'registration.invited', 'registration', registration.id, {});

    return jsonOk({
      ok: true,
      claim_url: `/claim/${token}`,
      expires_at: inserted[0]?.expires_at ?? null,
    });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

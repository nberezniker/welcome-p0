import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { jsonError, jsonOk, readJsonBody, internalError } from '../../../../lib/http';
import { recordConsent, suppressJobsForConsent, validateConsentInput } from '../../../../domain/consent';

/**
 * POST /api/consents/revoke — withdraws a purpose-scoped consent for the
 * authenticated account. action is FORCED to 'withdraw' regardless of body.
 * Queued outbox jobs that depended on this consent are suppressed (full
 * outbox cancellation ships with the Phase 3 worker; the request is audited now).
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = await readJsonBody(req);
    const bodyObj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const input = validateConsentInput({ ...bodyObj, action: 'withdraw' });
    if (!input.ok) return jsonError(400, input.code, input.message);

    const sql = getSql();
    await recordConsent(sql, auth.accountId, input.value);
    await suppressJobsForConsent(sql, auth.accountId, input.value.purpose, {
      scopeType: input.value.scopeType,
      scopeId: input.value.scopeId,
    });

    return jsonOk({ ok: true, action: 'withdraw', purpose: input.value.purpose });
  } catch (err) {
    return internalError(err);
  }
}

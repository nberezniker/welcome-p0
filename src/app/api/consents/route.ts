import { NextRequest } from 'next/server';
import { getSql } from '../../../lib/db';
import { requireAccount } from '../../../lib/auth';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../lib/http';
import { recordConsent, validateConsentInput } from '../../../domain/consent';

/** POST /api/consents — records a purpose-scoped consent for the AUTHENTICATED
 * account. The actor is never taken from the body. Append-only: no upsert. */
async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = await readJsonBody(req);
    const input = validateConsentInput(body);
    if (!input.ok) return jsonError(400, input.code, input.message);

    await recordConsent(getSql(), auth.accountId, input.value);
    return jsonOk({
      ok: true,
      action: input.value.action,
      purpose: input.value.purpose,
      scope_type: input.value.scopeType,
      scope_id: input.value.scopeId,
    });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { internalError, jsonError, jsonOk, privateCacheHeaders, withApi } from '../../../../../lib/http';
import { GoogleApiError, revokeGoogleToken } from '../../../../../lib/google-api';
import { deleteGrant, loadAccessTokenForRevocation } from '../../../../../lib/oauth-grants';
import { recordAudit } from '../../../../../lib/audit';
import { log } from '../../../../../lib/logger';
import { isGoogleOAuthProvider } from '../../../../../domain/google-oauth';

/**
 * DELETE /api/me/oauth/google?provider=google-contacts
 *
 * Disconnect. The order is deliberate and is the honest one:
 *
 *   1. HARD DELETE our copy of the grant — the row is gone, so nothing we hold
 *      can be used again, whatever Google answers next;
 *   2. THEN ask Google to revoke the token, best-effort. A failure there is
 *      reported in the response (`revoked_at_google: false`) but does NOT undo
 *      the disconnect: pretending the disconnect failed because a network call
 *      failed would leave the user with tokens they asked us to forget.
 *
 * The audit row records the provider and whether Google confirmed. Neither the
 * token nor its ciphertext appears in it — the token is read, used, and dropped
 * inside this request.
 *
 * Account deletion needs no route: `oauth_grants` cascades from accounts(id).
 */

const PROVIDER_PARAM = 'provider';

async function deleteRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const provider = req.nextUrl.searchParams.get(PROVIDER_PARAM) ?? '';
    if (!isGoogleOAuthProvider(provider)) {
      return jsonError(400, 'unknown_provider', 'provider must be google-contacts or google-calendar', {
        headers: privateCacheHeaders(),
      });
    }

    const sql = getSql();
    // Read the token BEFORE deleting the row: after the delete there is nothing
    // left to revoke, and a token we can no longer name is a token we can no
    // longer revoke.
    const token = await loadAccessTokenForRevocation(sql, auth.accountId, provider);
    const deleted = await deleteGrant(sql, { accountId: auth.accountId, provider });

    let revokedAtGoogle = false;
    if (token !== null) {
      try {
        await revokeGoogleToken(token);
        revokedAtGoogle = true;
      } catch (err) {
        // Best-effort by design (see the header). Only the typed code is logged:
        // the access token being revoked is the one value that must never appear
        // here, which is also why the untyped branch logs no message of its own.
        if (err instanceof GoogleApiError) {
          log.error('[oauth.google.disconnect] provider refused the revoke', {
            event: 'oauth_revoke_failed',
            provider: 'google',
            code: err.code,
            status: err.status ?? undefined,
          });
        } else {
          log.error('[oauth.google.disconnect] revoke failed', {
            event: 'oauth_revoke_error',
            provider: 'google',
            err,
          });
        }
      }
    }

    await recordAudit(sql, auth.accountId, 'oauth.google.disconnect', 'account', auth.accountId, {
      provider,
      // Whether we had anything to delete is a fact about OUR storage; a `false`
      // here is not an error, it just means there was nothing to disconnect.
      had_grant: deleted,
      revoked_at_google: revokedAtGoogle,
    });

    return jsonOk(
      {
        ok: true,
        provider,
        deleted,
        revoked_at_google: revokedAtGoogle,
        // Honest wording: the user asked us to forget it, and we have.
        state: 'not_connected',
      },
      { headers: privateCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

export const DELETE = withApi(deleteRoute);

import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { appBaseUrl, requireEncryptionKey } from '../../../../../lib/env';
import { localRedirectResponse } from '../../../../../lib/redirect';
import { GoogleApiError, exchangeAuthorizationCode } from '../../../../../lib/google-api';
import { verifyOAuthState } from '../../../../../lib/oauth-state';
import { consumeFlowState } from '../../../../../lib/oauth-flow';
import { upsertGrant } from '../../../../../lib/oauth-grants';
import { recordAudit } from '../../../../../lib/audit';
import { resolveProviderStatus } from '../../../../../lib/provider-status';
import { providerById } from '../../../../../domain/providers';
import {
  CONNECTIONS_PATH,
  GOOGLE_SCOPES,
  googleRedirectUri,
  scopesCover,
  type GoogleFlowStatus,
  type GoogleOAuthProvider,
} from '../../../../../domain/google-oauth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/oauth/google/callback?code=…&state=…
 *
 * Google sends the user's browser here. The path is exactly
 * `/api/oauth/google/callback` because that is the URI registered on the OAuth
 * client — see GOOGLE_REDIRECT_PATH in src/domain/google-oauth.ts, which is the
 * only place it is spelled.
 *
 * THE ORDER OF CHECKS IS THE SECURITY MODEL, and every one of them comes before
 * the code is exchanged:
 *
 *   1. the instance must still be configured (a deploy that dropped the env must
 *      not redeem anything);
 *   2. the session must exist — the callback is a top-level GET, so the Lax
 *      session cookie is sent, and a flow that lost its session is abandoned
 *      rather than completed for an unknown account;
 *   3. the state's signature, then its shape, then its expiry
 *      (`verifyOAuthState` — MAC first, so no decision is ever made on
 *      unauthenticated JSON);
 *   4. the session account must equal the account the state was issued to, so a
 *      state stolen or leaked from another browser cannot attach a Google
 *      account to the wrong WELCOME account;
 *   5. the `jti` must be CLAIMED — a single conditional UPDATE that makes the
 *      flow single-use even under concurrent callbacks (src/lib/oauth-flow.ts).
 *
 * Then the code is exchanged with the PKCE verifier that never left the server,
 * the granted scopes are checked against what the provider needs, the tokens are
 * encrypted and stored, and the browser is sent back to /me/connections with one
 * status WORD.
 *
 * IT NEVER THROWS A 500 AT THE USER. Every failure — including an unexpected one
 * — is a redirect with an honest flag. Google's own `error=` parameter
 * (`access_denied` when the user presses cancel) is mapped to `denied`.
 */

function backTo(status: GoogleFlowStatus, provider: string): Response {
  // Relative, built from constants only — see src/lib/redirect.ts for why.
  return localRedirectResponse(
    CONNECTIONS_PATH,
    { google: provider, status },
    { 'Cache-Control': 'no-store, private' },
  );
}

export async function GET(req: NextRequest) {
  // Whatever happens, the user ends up back on the connections page; the default
  // provider word is only used when the state itself could not be trusted.
  let providerWord = 'google-contacts';
  try {
    // Named `query`, not `params`: this is a URLSearchParams, and a local called
    // `params` here would read like the route's (Promise-valued) `params` — the
    // distinction the static-safety gate (`tests/unit/static-safety.test.ts`)
    // keeps unambiguous for the whole of src/app.
    const query = req.nextUrl.searchParams;
    const errorParam = query.get('error');
    const code = query.get('code');
    const state = query.get('state');

    // Both Google registry rows are gated by the SAME two variables
    // (GOOGLE_OAUTH_CLIENT_ID / _SECRET, src/domain/providers.ts), so one
    // resolution answers for the whole instance: if this row is not live here,
    // nothing can be redeemed for either provider — and we say so instead of
    // failing at the token endpoint.
    const gateRow = providerById('google-contacts');
    const gate = gateRow ? resolveProviderStatus(gateRow) : null;
    if (!gate || gate.status !== 'live' || gate.reason_code !== null) {
      return backTo('not_configured', providerWord);
    }

    const auth = await requireAccount(req);
    if (!auth) {
      // The session died during consent (or the callback was opened elsewhere).
      // Abandoning is the honest answer: we will not store a grant for an
      // account we cannot identify.
      return localRedirectResponse(
        '/login',
        { next: CONNECTIONS_PATH },
        { 'Cache-Control': 'no-store, private' },
      );
    }

    const verified = verifyOAuthState(state, requireEncryptionKey());
    if (!verified.ok) {
      // Tampered, replayed and expired all look the same from outside — which is
      // the point: the page says "that attempt is no longer valid" and nothing
      // more precise that could help someone probe the flow.
      return backTo('invalid_state', providerWord);
    }
    const { payload } = verified;
    providerWord = payload.provider;

    // A state is bound to the account that asked for it. A mismatch is not a
    // recoverable situation: it means the two halves of the flow do not belong
    // to the same person.
    if (payload.accountId !== auth.accountId) return backTo('invalid_state', providerWord);

    // Google reports a refusal on the same URL; do it before touching the flow
    // row so the attempt stays unconsumed and can simply be retried.
    if (errorParam) {
      const denied = errorParam === 'access_denied';
      await recordAudit(getSql(), auth.accountId, 'oauth.google.denied', 'account', auth.accountId, {
        provider: providerWord,
        // Google's own error code is machine-readable and carries no user data.
        error: denied ? 'access_denied' : 'provider_error',
      });
      return backTo(denied ? 'denied' : 'exchange_failed', providerWord);
    }

    if (!code) return backTo('invalid_state', providerWord);

    const sql = getSql();
    // Single use: whoever wins this statement gets the PKCE verifier.
    const flow = await consumeFlowState(sql, payload.jti);
    if (!flow) return backTo('invalid_state', providerWord);

    const provider: GoogleOAuthProvider = flow.provider;
    providerWord = provider;

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';
    const tokens = await exchangeAuthorizationCode({
      clientId,
      clientSecret,
      redirectUri: googleRedirectUri(appBaseUrl()),
      code,
      codeVerifier: flow.codeVerifier,
    });

    // What we asked for vs what was actually granted. Consent screens can be
    // narrowed by the user; storing a grant that cannot do the job would turn a
    // refusal into a mysterious failure later.
    const granted = tokens.scopes.length > 0 ? tokens.scopes : [...GOOGLE_SCOPES[provider]];
    if (!scopesCover(granted, GOOGLE_SCOPES[provider])) {
      await recordAudit(sql, auth.accountId, 'oauth.google.scope_missing', 'account', auth.accountId, {
        provider,
        scopes: [...GOOGLE_SCOPES[provider]],
      });
      return backTo('exchange_failed', provider);
    }

    await upsertGrant(sql, { accountId: auth.accountId, provider, tokens });

    // The durable proof of a connection is the grant row; the audit row records
    // only who/what/when. The scope URLs are public identifiers, and the tokens
    // are not in it — by construction, since `tokens` never reaches this call.
    await recordAudit(sql, auth.accountId, 'oauth.google.connect', 'account', auth.accountId, {
      provider,
      scopes: granted,
    });

    return backTo('connected', provider);
  } catch (err) {
    if (err instanceof GoogleApiError) {
      // Typed and token-free: the message is the CODE.
      console.error(`[oauth.google.callback] ${err.code} status=${err.status ?? 'none'}`);
    } else {
      console.error('[oauth.google.callback] failed', err instanceof Error ? err.message : 'unknown_error');
    }
    return backTo('exchange_failed', providerWord);
  }
}

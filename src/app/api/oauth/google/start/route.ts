import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { appBaseUrl, requireEncryptionKey } from '../../../../../lib/env';
import { localRedirectResponse } from '../../../../../lib/redirect';
import { generatePkcePair } from '../../../../../lib/oauth-pkce';
import { signOAuthState } from '../../../../../lib/oauth-state';
import { purgeExpiredFlowStates, startFlowState } from '../../../../../lib/oauth-flow';
import { recordAudit } from '../../../../../lib/audit';
import { resolveProviderStatus } from '../../../../../lib/provider-status';
import { log } from '../../../../../lib/logger';
import { providerById, type ProviderId } from '../../../../../domain/providers';
import {
  CONNECTIONS_PATH,
  GOOGLE_OAUTH_STATE_TTL_SECONDS,
  GOOGLE_SCOPES,
  buildGoogleAuthorizationUrl,
  googleRedirectUri,
  isGoogleOAuthProvider,
  type GoogleFlowStatus,
  type GoogleOAuthProvider,
} from '../../../../../domain/google-oauth';

export const dynamic = 'force-dynamic';

/**
 * GET /api/oauth/google/start?provider=google-contacts
 *
 * Starts the consent flow: builds the Google authorization URL and redirects the
 * browser to it. It is a GET because the connect control is a plain link — the
 * user's own click carries the action, which is exactly the "act only when the
 * user pressed something" rule of the connections page.
 *
 * IT MAKES NO GOOGLE CALL. Building a URL is string work; the first byte that
 * reaches Google is the browser's navigation after this response. So "nothing is
 * fetched from Google before the user presses connect" holds structurally, not by
 * convention.
 *
 * Reads the user's own decision (`?provider=`) but trusts nothing:
 *   - a signed-in session is REQUIRED (no anonymous flow can be started, so no
 *     grant can ever be created for an account nobody is logged into). Signed
 *     out, the control simply sends the visitor to /login;
 *   - the provider must be one of the two Google registry rows, and this INSTANCE
 *     must actually be configured for it — otherwise the user is sent back to
 *     /me/connections with an honest `not_configured` flag rather than to a
 *     Google error page;
 *   - an unparsable provider is a 400, since guessing one would mean asking for a
 *     scope the user never chose.
 *
 * Everything the browser receives is a redirect carrying a short status WORD.
 * No token, no PKCE verifier and no state value is ever in a response body.
 */

function backTo(status: GoogleFlowStatus, provider: string): Response {
  // A relative Location: the browser resolves it against the URL it asked for, so
  // neither a wrong APP_BASE_URL nor an attacker-supplied Host header can move the
  // user off this deployment (src/lib/redirect.ts explains the choice).
  return localRedirectResponse(
    CONNECTIONS_PATH,
    { google: provider, status },
    { 'Cache-Control': 'no-store, private' },
  );
}

export async function GET(req: NextRequest) {
  const rawProvider = req.nextUrl.searchParams.get('provider') ?? '';
  try {
    const auth = await requireAccount(req);
    if (!auth) {
      // Inert without a session (project brief): the control sends you to sign
      // in and nothing about Google happens.
      return localRedirectResponse(
        '/login',
        { next: CONNECTIONS_PATH },
        { 'Cache-Control': 'no-store, private' },
      );
    }

    if (!isGoogleOAuthProvider(rawProvider)) {
      // An unknown provider is never guessed into one of the two real scopes.
      return NextResponse.json(
        { code: 'unknown_provider', message: 'provider must be google-contacts or google-calendar' },
        { status: 400, headers: { 'Cache-Control': 'no-store, private' } },
      );
    }
    const provider: GoogleOAuthProvider = rawProvider;

    const registryRow = providerById(provider as ProviderId);
    const resolution = registryRow ? resolveProviderStatus(registryRow) : null;
    if (!resolution || resolution.status !== 'live' || resolution.reason_code !== null) {
      // Honest state: this instance has no OAuth client (or the provider is not
      // live), so there is nothing to consent to.
      return backTo('not_configured', provider);
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
    const redirectUri = googleRedirectUri(appBaseUrl());
    const sql = getSql();

    // Opportunistic housekeeping: an abandoned attempt leaves nothing behind.
    await purgeExpiredFlowStates(sql);

    const pkce = generatePkcePair();
    const flow = await startFlowState(sql, {
      accountId: auth.accountId,
      provider,
      codeVerifier: pkce.verifier,
      ttlSeconds: GOOGLE_OAUTH_STATE_TTL_SECONDS,
      redirectPath: CONNECTIONS_PATH,
    });
    const state = signOAuthState(
      { jti: flow.jti, accountId: auth.accountId, provider },
      requireEncryptionKey(),
    );

    // The trace of a START, not of a connection: the grant row is what proves a
    // connection, and an attempt the user abandons should not read as one.
    // Scope URLs are public identifiers, not secrets.
    await recordAudit(sql, auth.accountId, 'oauth.google.start', 'account', auth.accountId, {
      provider,
      scopes: [...GOOGLE_SCOPES[provider]],
    });

    const authorizeUrl = buildGoogleAuthorizationUrl({
      clientId,
      redirectUri,
      provider,
      state,
      codeChallenge: pkce.challenge,
    });
    return NextResponse.redirect(authorizeUrl, {
      status: 302,
      headers: {
        'Cache-Control': 'no-store, private',
        // The URL carries a signed state; keep it out of any downstream logs.
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (err) {
    // Even an unexpected failure answers with a flag, never a 500 page: the user
    // came here from a button and must land back on the page that explains.
    // The error object is passed whole (name/message/stack) — it is this
    // server's own failure, and no OAuth parameter reaches it.
    log.error('[oauth.google.start] failed', { event: 'oauth_start_failed', provider: 'google', err });
    return backTo('unavailable', rawProvider);
  }
}

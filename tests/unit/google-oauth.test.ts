import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptValue, encryptValue } from '../../src/lib/crypto';
import { generatePkcePair, pkceChallenge } from '../../src/lib/oauth-pkce';
import { oauthStateKey, signOAuthState, verifyOAuthState } from '../../src/lib/oauth-state';
import {
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CONTACTS_SCOPE,
  GOOGLE_FLOW_STATUSES,
  GOOGLE_REDIRECT_PATH,
  GOOGLE_SCOPES,
  buildCalendarEventBody,
  buildGoogleAuthorizationUrl,
  classifyGoogleHttpError,
  googleCalendarAttendees,
  googleGrantState,
  googleRedirectUri,
  isGoogleFlowStatus,
  isGoogleOAuthProvider,
  needsRefresh,
  parseCreatedCalendarEvent,
  parseGoogleErrorBody,
  parseGoogleTokenResponse,
  parsePeopleConnections,
  scopesCover,
} from '../../src/domain/google-oauth';

/**
 * Phase 2 unit contract (docs-internal/product/GOOGLE_OAUTH_SETUP.md).
 *
 * No database, no network, no clock: every function here is a pure decision, so
 * the security-critical branches — a tampered state, an expired state, a stolen
 * PKCE verifier, a counterpart email that must not travel — are proven rather
 * than asserted in prose.
 */

/** 32 bytes base64, the shape ENCRYPTION_KEY must have. */
const KEY = Buffer.alloc(32, 11).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 12).toString('base64');
const NOW = new Date('2026-09-16T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Per-provider scopes — the closed set
// ---------------------------------------------------------------------------

test('google-oauth: the two providers ask for exactly two read/write-narrow scopes', () => {
  assert.deepEqual(GOOGLE_SCOPES['google-contacts'], ['https://www.googleapis.com/auth/contacts.readonly']);
  assert.deepEqual(GOOGLE_SCOPES['google-calendar'], ['https://www.googleapis.com/auth/calendar.events']);
  assert.equal(GOOGLE_CONTACTS_SCOPE, 'https://www.googleapis.com/auth/contacts.readonly');
  assert.equal(GOOGLE_CALENDAR_SCOPE, 'https://www.googleapis.com/auth/calendar.events');

  // The read-WRITE contacts scope, Gmail and Drive must never appear. This is the
  // assertion that makes "we only read a contact list" structural.
  //
  // `auth/contacts` is a PREFIX of `auth/contacts.readonly`, so it is compared as
  // a whole scope, not as a substring — the whole point is that the exact
  // write-capable identifier is absent.
  const scopes = Object.values(GOOGLE_SCOPES).flat();
  for (const forbidden of [
    'https://www.googleapis.com/auth/contacts',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.readonly',
  ]) {
    assert.equal(scopes.includes(forbidden), false, `scope set must not contain ${forbidden}`);
  }
  // And nothing beyond the two: a scope added by accident is caught here.
  assert.equal(scopes.length, 2);
});

test('google-oauth: only the two registered ids are Google providers', () => {
  assert.equal(isGoogleOAuthProvider('google-contacts'), true);
  assert.equal(isGoogleOAuthProvider('google-calendar'), true);
  assert.equal(isGoogleOAuthProvider('microsoft-people'), false);
  assert.equal(isGoogleOAuthProvider('notion'), false);
  assert.equal(isGoogleOAuthProvider(null), false);
  assert.equal(isGoogleOAuthProvider(undefined), false);
});

test('google-oauth: the redirect path is exactly the one registered at Google', () => {
  // The OAuth client `welcome-web` has these two URIs registered; the deployed
  // path is the one this constant produces.
  assert.equal(GOOGLE_REDIRECT_PATH, '/api/oauth/google/callback');
  assert.equal(googleRedirectUri('https://welcome.colmogravity.net'), 'https://welcome.colmogravity.net/api/oauth/google/callback');
  assert.equal(googleRedirectUri('http://localhost:3000'), 'http://localhost:3000/api/oauth/google/callback');
  // A trailing slash on APP_BASE_URL must not produce a double slash: Google
  // compares redirect URIs literally, so one character here is a hard failure.
  assert.equal(googleRedirectUri('https://welcome.colmogravity.net/'), 'https://welcome.colmogravity.net/api/oauth/google/callback');
  assert.equal(googleRedirectUri('https://welcome.colmogravity.net///'), 'https://welcome.colmogravity.net/api/oauth/google/callback');
});

// ---------------------------------------------------------------------------
// Authorization URL shape
// ---------------------------------------------------------------------------

test('google-oauth: the authorization URL carries PKCE, offline access and the provider scope', () => {
  const url = new URL(
    buildGoogleAuthorizationUrl({
      clientId: 'client-123.apps.googleusercontent.com',
      redirectUri: 'https://welcome.colmogravity.net/api/oauth/google/callback',
      provider: 'google-contacts',
      state: 'signed.state',
      codeChallenge: 'challenge-value',
    }),
  );

  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');
  const p = url.searchParams;
  assert.equal(p.get('client_id'), 'client-123.apps.googleusercontent.com');
  assert.equal(p.get('redirect_uri'), 'https://welcome.colmogravity.net/api/oauth/google/callback');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('scope'), GOOGLE_CONTACTS_SCOPE);
  assert.equal(p.get('state'), 'signed.state');
  assert.equal(p.get('code_challenge'), 'challenge-value');
  // `plain` would put the verifier itself in the URL; S256 is the only method.
  assert.equal(p.get('code_challenge_method'), 'S256');
  // This pair is what makes Google return a refresh token at all.
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent');
  // Never inherit previously granted scopes silently: each provider asks for its
  // own, and the user sees exactly that screen.
  assert.equal(p.get('include_granted_scopes'), 'false');
});

test('google-oauth: the calendar URL asks for the calendar scope only', () => {
  const url = new URL(
    buildGoogleAuthorizationUrl({
      clientId: 'c',
      redirectUri: 'http://localhost:3000/api/oauth/google/callback',
      provider: 'google-calendar',
      state: 's',
      codeChallenge: 'x',
    }),
  );
  assert.equal(url.searchParams.get('scope'), GOOGLE_CALENDAR_SCOPE);
  assert.equal(url.searchParams.get('scope')?.includes('contacts'), false);
});

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

test('pkce: a pair is fresh, S256, and the challenge is the digest of the verifier', () => {
  const a = generatePkcePair();
  const b = generatePkcePair();

  assert.notEqual(a.verifier, b.verifier, 'each flow needs its own verifier');
  assert.equal(a.method, 'S256');
  // RFC 7636 §4.1: 43–128 chars from the unreserved set.
  assert.equal(a.verifier.length, 43);
  assert.match(a.verifier, /^[A-Za-z0-9\-._~]{43}$/);
  assert.equal(a.challenge, pkceChallenge(a.verifier));
  assert.notEqual(a.challenge, a.verifier, 'the challenge must not be the verifier (that is `plain`)');
  assert.match(a.challenge, /^[A-Za-z0-9\-_]{43}$/);

  // The published S256 test vector (RFC 7636 Appendix B): proves we compute the
  // challenge the way Google does, not merely consistently with ourselves.
  const expected = createHash('sha256')
    .update('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'ascii')
    .digest('base64url');
  assert.equal(expected, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), expected);
});

// ---------------------------------------------------------------------------
// Signed, single-use state
// ---------------------------------------------------------------------------

const PAYLOAD = { jti: 'flow-id-0123456789', accountId: 'acct-1', provider: 'google-contacts' as const };

test('oauth-state: a state round-trips and carries the provider it was issued for', () => {
  const state = signOAuthState(PAYLOAD, KEY, NOW, 600);
  const verified = verifyOAuthState(state, KEY, NOW);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.payload.jti, PAYLOAD.jti);
  assert.equal(verified.payload.accountId, PAYLOAD.accountId);
  assert.equal(verified.payload.provider, 'google-contacts');
  assert.equal(verified.payload.exp - verified.payload.iat, 600);
  // The state is opaque: no verifier, no token, nothing readable without the key.
  assert.equal(state.includes('verifier'), false);
});

test('oauth-state: the PKCE verifier never travels in the state', () => {
  const { verifier } = generatePkcePair();
  const state = signOAuthState(PAYLOAD, KEY, NOW, 600);
  // Only the jti identifies the server-side row that holds the verifier.
  const decoded = Buffer.from(state.split('.')[0]!, 'base64url').toString('utf8');
  assert.equal(decoded.includes(verifier), false);
  assert.equal(Buffer.from(state.split('.')[0]!, 'base64url').toString('utf8').includes('code_verifier'), false);
});

test('oauth-state: a tampered payload is rejected as bad_signature', () => {
  const state = signOAuthState(PAYLOAD, KEY, NOW, 600);
  const [encoded, mac] = state.split('.') as [string, string];

  // Re-encode the payload with a DIFFERENT account and keep the old MAC: this is
  // exactly the forgery an attacker would attempt with a leaked state.
  const forged = Buffer.from(
    JSON.stringify({ ...PAYLOAD, accountId: 'someone-else', exp: Math.floor(NOW.getTime() / 1000) + 600, v: 1, iat: Math.floor(NOW.getTime() / 1000) }),
    'utf8',
  ).toString('base64url');
  assert.deepEqual(verifyOAuthState(`${forged}.${mac}`, KEY, NOW), { ok: false, code: 'bad_signature' });

  // A single flipped character in the MAC — the FIRST one, because it carries MAC
  // bits. (The LAST character of a 43-char base64url run carries only padding
  // bits, which Node's decoder ignores: flipping it changes nothing meaningful,
  // and `verifyOAuthState` rejects non-canonical spellings precisely so that
  // "changed string, same signature" cannot exist.)
  const flipped = `${encoded}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  assert.deepEqual(verifyOAuthState(flipped, KEY, NOW), { ok: false, code: 'bad_signature' });

  // A padding-bit variant of an otherwise perfect signature is refused too: one
  // accepted spelling per signature, so a "modified" state is never valid.
  const lastChar = mac.at(-1) ?? 'A';
  const paddingVariant = `${encoded}.${mac.slice(0, -1)}${lastChar === 'B' ? 'A' : 'B'}`;
  assert.deepEqual(verifyOAuthState(paddingVariant, KEY, NOW), { ok: false, code: 'bad_signature' });

  // Missing MAC, extra dot, empty, wrong type, absurd length.
  assert.deepEqual(verifyOAuthState(encoded, KEY, NOW), { ok: false, code: 'malformed' });
  assert.deepEqual(verifyOAuthState(`${encoded}.${mac}.extra`, KEY, NOW), { ok: false, code: 'malformed' });
  assert.deepEqual(verifyOAuthState('', KEY, NOW), { ok: false, code: 'malformed' });
  assert.deepEqual(verifyOAuthState(null, KEY, NOW), { ok: false, code: 'malformed' });
  assert.deepEqual(verifyOAuthState('x'.repeat(5000), KEY, NOW), { ok: false, code: 'malformed' });
});

test('oauth-state: a state signed with another key is rejected', () => {
  const state = signOAuthState(PAYLOAD, KEY, NOW, 600);
  assert.deepEqual(verifyOAuthState(state, OTHER_KEY, NOW), { ok: false, code: 'bad_signature' });
});

test('oauth-state: an expired state is rejected, and the boundary is exclusive', () => {
  const state = signOAuthState(PAYLOAD, KEY, NOW, 600);
  assert.equal(verifyOAuthState(state, KEY, new Date(NOW.getTime() + 599_000)).ok, true);
  assert.deepEqual(
    verifyOAuthState(state, KEY, new Date(NOW.getTime() + 600_000)),
    { ok: false, code: 'expired' },
  );
  assert.deepEqual(
    verifyOAuthState(state, KEY, new Date(NOW.getTime() + 86_400_000)),
    { ok: false, code: 'expired' },
  );
});

test('oauth-state: a signed but wrong-shaped payload is malformed, never accepted', () => {
  // Signed by us, so the MAC is fine — the SHAPE is what must reject it.
  for (const bad of [
    { ...PAYLOAD, v: 2 },
    { ...PAYLOAD, jti: 'short' },
    { ...PAYLOAD, provider: 'microsoft-people' },
    { ...PAYLOAD, accountId: '' },
    { ...PAYLOAD, exp: 'soon' },
    { ...PAYLOAD, exp: 1, iat: 2 },
  ]) {
    const encoded = Buffer.from(JSON.stringify(bad), 'utf8').toString('base64url');
    const mac = createHmac('sha256', oauthStateKey(KEY)).update(encoded, 'utf8').digest('base64url');
    assert.deepEqual(
      verifyOAuthState(`${encoded}.${mac}`, KEY, NOW),
      { ok: false, code: 'malformed' },
      `payload ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test('oauth-state: the MAC key is derived, not the encryption key itself', () => {
  const derived = oauthStateKey(KEY);
  assert.equal(derived.length, 32);
  assert.notEqual(derived.toString('base64'), Buffer.alloc(32, 11).toString('base64'));
  // Same input → same key (deterministic across processes/deploys).
  assert.equal(oauthStateKey(KEY).toString('hex'), derived.toString('hex'));
  // A different ENCRYPTION_KEY gives a different MAC key.
  assert.notEqual(oauthStateKey(OTHER_KEY).toString('hex'), derived.toString('hex'));
  // A key that is not 32 bytes is refused, not stretched.
  assert.throws(() => oauthStateKey(Buffer.alloc(16, 1).toString('base64')));
});

// ---------------------------------------------------------------------------
// Token payloads, errors, encryption round-trip
// ---------------------------------------------------------------------------

test('google-oauth: a token response is parsed into an absolute expiry and a scope list', () => {
  const tokens = parseGoogleTokenResponse(
    {
      access_token: 'ya29.access',
      refresh_token: '1//refresh',
      expires_in: 3599,
      scope: `${GOOGLE_CONTACTS_SCOPE} openid`,
      token_type: 'Bearer',
    },
    NOW,
  );
  assert.ok(tokens);
  assert.equal(tokens.accessToken, 'ya29.access');
  assert.equal(tokens.refreshToken, '1//refresh');
  assert.deepEqual(tokens.scopes, [GOOGLE_CONTACTS_SCOPE, 'openid']);
  assert.equal(tokens.tokenType, 'Bearer');
  assert.equal(tokens.expiresAt?.toISOString(), new Date(NOW.getTime() + 3_599_000).toISOString());

  // A refresh response carries no refresh token: null means "unchanged", and the
  // sql layer keeps the stored one.
  const refreshed = parseGoogleTokenResponse({ access_token: 'ya29.new', expires_in: 3599 }, NOW);
  assert.equal(refreshed?.refreshToken, null);

  // No access token is a failure, not a grant with an empty string in it.
  assert.equal(parseGoogleTokenResponse({ expires_in: 10 }, NOW), null);
  assert.equal(parseGoogleTokenResponse({ access_token: '' }, NOW), null);
  assert.equal(parseGoogleTokenResponse('nope', NOW), null);
  assert.equal(parseGoogleTokenResponse(null, NOW), null);
  // No expires_in at all: the expiry is unknown, which is honest (null), not 1970.
  assert.equal(parseGoogleTokenResponse({ access_token: 'x' }, NOW)?.expiresAt, null);
});

test('google-oauth: errors are classified, with invalid_grant winning over the status', () => {
  // Google reports a revoked grant as 400 on the token endpoint and 401 on the
  // resource APIs; only the error body distinguishes it, and that distinction is
  // what lets the UI say "revoked" instead of "error".
  assert.equal(classifyGoogleHttpError(400, { error: 'invalid_grant' }), 'invalid_grant');
  assert.equal(classifyGoogleHttpError(401, { error: 'invalid_grant' }), 'invalid_grant');
  assert.equal(classifyGoogleHttpError(401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } }), 'unauthorized');
  assert.equal(classifyGoogleHttpError(403, { error: { code: 403, status: 'PERMISSION_DENIED' } }), 'forbidden');
  assert.equal(classifyGoogleHttpError(429, {}), 'rate_limited');
  assert.equal(classifyGoogleHttpError(503, {}), 'server_error');
  assert.equal(classifyGoogleHttpError(500, null), 'server_error');
  assert.equal(classifyGoogleHttpError(400, { error: 'invalid_request' }), 'invalid_request');
  assert.equal(classifyGoogleHttpError(400, { error: 'invalid_client' }), 'invalid_request');
  assert.equal(parseGoogleErrorBody({ error: 'x', error_description: 'y' }).description, 'y');
  assert.deepEqual(parseGoogleErrorBody(null), { error: null, description: null });
});

test('crypto: a delivered token set survives the encrypt/decrypt round trip, and tampering is caught', () => {
  const access = 'ya29.a0AfH6SMB-access-token-value';
  const refresh = '1//0g-refresh-token-value';
  const storedAccess = encryptValue(access, KEY);
  const storedRefresh = encryptValue(refresh, KEY);

  // What the database holds is never the token.
  assert.equal(storedAccess.includes(access), false);
  assert.equal(storedRefresh.includes(refresh), false);
  assert.match(storedAccess, /^v1\./);

  assert.equal(decryptValue(storedAccess, KEY), access);
  assert.equal(decryptValue(storedRefresh, KEY), refresh);
  // A different ENCRYPTION_KEY cannot read it (rotation is a reconnect, not a leak).
  assert.throws(() => decryptValue(storedAccess, OTHER_KEY));
  // A flipped base64 character fails the GCM tag rather than returning bytes.
  const parts = storedAccess.split('.');
  const tampered = `${parts[0]}.${parts[1]}.${parts[2]!.slice(0, -2)}AA.${parts[3]}`;
  assert.throws(() => decryptValue(tampered, KEY));
});

// ---------------------------------------------------------------------------
// Grant state — derived from facts
// ---------------------------------------------------------------------------

test('grant state: no row means not connected, and nothing else', () => {
  assert.equal(googleGrantState(null, GOOGLE_SCOPES['google-contacts'], NOW), 'not_connected');
});

test('grant state: a live grant with the right scope is connected', () => {
  assert.equal(
    googleGrantState(
      {
        scopes: [GOOGLE_CONTACTS_SCOPE],
        expiresAt: new Date(NOW.getTime() + 3600_000),
        refreshFailedAt: null,
        revokedAt: null,
        hasRefreshToken: true,
      },
      GOOGLE_SCOPES['google-contacts'],
      NOW,
    ),
    'connected',
  );
});

test('grant state: revoked wins over everything else', () => {
  assert.equal(
    googleGrantState(
      {
        scopes: [GOOGLE_CONTACTS_SCOPE],
        expiresAt: new Date(NOW.getTime() + 3600_000),
        refreshFailedAt: null,
        revokedAt: NOW,
        hasRefreshToken: true,
      },
      GOOGLE_SCOPES['google-contacts'],
      NOW,
    ),
    'revoked',
  );
});

test('grant state: a failed refresh, a dead token with no renewer, and a missing scope all read as expired', () => {
  const base = {
    scopes: [GOOGLE_CONTACTS_SCOPE],
    expiresAt: new Date(NOW.getTime() + 3600_000),
    refreshFailedAt: null,
    revokedAt: null,
    hasRefreshToken: true,
  };
  // We tried to renew and could not.
  assert.equal(
    googleGrantState({ ...base, refreshFailedAt: NOW }, GOOGLE_SCOPES['google-contacts'], NOW),
    'expired',
  );
  // Past its expiry with nothing to renew it with.
  assert.equal(
    googleGrantState(
      { ...base, expiresAt: new Date(NOW.getTime() - 1), hasRefreshToken: false },
      GOOGLE_SCOPES['google-contacts'],
      NOW,
    ),
    'expired',
  );
  // Expired but renewable: still usable, so still connected.
  assert.equal(
    googleGrantState({ ...base, expiresAt: new Date(NOW.getTime() - 1) }, GOOGLE_SCOPES['google-contacts'], NOW),
    'connected',
  );
  // Google granted fewer scopes than the provider needs: a usable-looking token
  // that cannot do the job must not read as connected.
  assert.equal(
    googleGrantState({ ...base, scopes: [] }, GOOGLE_SCOPES['google-contacts'], NOW),
    'expired',
  );
  assert.equal(
    googleGrantState({ ...base, scopes: [GOOGLE_CALENDAR_SCOPE] }, GOOGLE_SCOPES['google-contacts'], NOW),
    'expired',
  );
});

test('grant state: refresh is attempted only for a renewable, past-expiry grant', () => {
  assert.equal(needsRefresh({ expiresAt: new Date(NOW.getTime() + 1000), hasRefreshToken: true }, NOW), false);
  assert.equal(needsRefresh({ expiresAt: new Date(NOW.getTime() - 1000), hasRefreshToken: true }, NOW), true);
  assert.equal(needsRefresh({ expiresAt: null, hasRefreshToken: true }, NOW), true);
  // No refresh token: there is nothing to refresh WITH — the state layer already
  // calls that grant expired.
  assert.equal(needsRefresh({ expiresAt: new Date(NOW.getTime() - 1000), hasRefreshToken: false }, NOW), false);
  assert.equal(scopesCover(['a', 'b'], ['a']), true);
  assert.equal(scopesCover(['a'], ['a', 'b']), false);
  assert.equal(scopesCover([], []), true);
});

// ---------------------------------------------------------------------------
// People API parsing — the third party's data
// ---------------------------------------------------------------------------

test('people: only names and email addresses are read, everything else is ignored', () => {
  const parsed = parsePeopleConnections({
    connections: [
      {
        names: [{ displayName: 'Ada Lovelace' }],
        emailAddresses: [{ value: 'Ada@Example.COM' }],
        phoneNumbers: [{ value: '+34 600 000 000' }],
        birthdays: [{ date: { month: 12, day: 10 } }],
        addresses: [{ streetAddress: '1 Analytical Engine Way' }],
      },
      { names: [{ displayName: 'No Mail' }], emailAddresses: [] },
      { names: [], emailAddresses: [{ value: 'not-an-email' }] },
      { names: [{ displayName: 'Two Boxes' }], emailAddresses: [{ value: 'a@b.co' }, { value: 'c@d.co' }] },
      { names: [{ displayName: 'Twice' }], emailAddresses: [{ value: 'a@b.co' }] },
    ],
  });

  // Normalized with the same function the address-book import uses, so the
  // lookup hash is comparable across both doors.
  assert.deepEqual(parsed.contacts, [
    { email: 'ada@example.com', name: 'Ada Lovelace' },
    { email: 'a@b.co', name: 'Two Boxes' },
    { email: 'c@d.co', name: 'Two Boxes' },
  ]);
  // Two connections with no usable address, and a duplicate that is not a skip.
  assert.equal(parsed.skipped, 2);
  assert.equal(parsed.truncated, false);
  // Nothing but the two fields survives: a phone number or a birthday is not a
  // contact candidate and must not be able to reach the matching code.
  const raw = JSON.stringify(parsed);
  assert.equal(raw.includes('600 000 000'), false);
  assert.equal(raw.includes('Analytical Engine'), false);
  assert.equal(raw.includes('December'), false);
});

test('people: a page token means truncated, and the ceiling is honest', () => {
  assert.equal(parsePeopleConnections({ connections: [], nextPageToken: 'CAEQAA' }).truncated, true);
  assert.equal(parsePeopleConnections({ connections: [] }).truncated, false);
  // The cap is applied per call: the caller passes what is left of its budget.
  const capped = parsePeopleConnections(
    {
      connections: [
        { names: [{ displayName: 'A' }], emailAddresses: [{ value: 'a@x.co' }] },
        { names: [{ displayName: 'B' }], emailAddresses: [{ value: 'b@x.co' }] },
      ],
    },
    { maxContacts: 1 },
  );
  assert.equal(capped.contacts.length, 1);
  // Unusable input is an empty page, never a throw.
  assert.deepEqual(parsePeopleConnections(null), { contacts: [], skipped: 0, truncated: false });
  assert.deepEqual(parsePeopleConnections({ connections: 'nope' }), { contacts: [], skipped: 0, truncated: false });
  assert.deepEqual(parsePeopleConnections({ connections: [null, 'x'] }).skipped, 2);
});

// ---------------------------------------------------------------------------
// Calendar privacy rule
// ---------------------------------------------------------------------------

test('calendar: NO counterpart email is sent by default — the attendee list is empty', () => {
  // The default path (no opt-in), which is the path every test and every
  // integration exercise unless it explicitly asks otherwise.
  assert.deepEqual(googleCalendarAttendees('ada@example.com', false), []);
  assert.deepEqual(googleCalendarAttendees('ada@example.com', false), []);
  // Nothing supplied is nothing sent, even with the opt-in on.
  assert.deepEqual(googleCalendarAttendees(null, true), []);
  assert.deepEqual(googleCalendarAttendees('   ', true), []);
});

test('calendar: the counterpart email travels only with an explicit per-action opt-in', () => {
  assert.deepEqual(googleCalendarAttendees('Ada@Example.com', true), ['ada@example.com']);
  // And the default event body really carries no attendees field at all.
  const body = buildCalendarEventBody({
    summary: 'Meeting with Ada Lovelace',
    description: 'Wed, 16 Sept 2026, 10:00–11:00',
    timezone: 'Europe/Madrid',
    startsAt: new Date('2026-09-16T08:00:00.000Z'),
    endsAt: new Date('2026-09-16T09:00:00.000Z'),
    attendees: googleCalendarAttendees('ada@example.com', false),
    sourceUrl: 'https://welcome.colmogravity.net/p/abc',
  });
  assert.equal('attendees' in body, false, 'the default body must not even have an attendees key');
  assert.equal(JSON.stringify(body).includes('@'), false, 'no address of any kind in the default body');

  const optedIn = buildCalendarEventBody({
    summary: 'Meeting',
    description: null,
    timezone: 'Europe/Madrid',
    startsAt: new Date('2026-09-16T08:00:00.000Z'),
    endsAt: null,
    attendees: googleCalendarAttendees('ada@example.com', true),
  });
  assert.deepEqual(optedIn.attendees, [{ email: 'ada@example.com' }]);
});

test('calendar: the event body keeps the agreed wall clock and the app timezone', () => {
  const body = buildCalendarEventBody({
    summary: 'Meeting with Ada',
    description: 'when',
    timezone: 'Europe/Madrid',
    startsAt: new Date('2026-09-16T08:00:00.000Z'),
    endsAt: new Date('2026-09-16T09:30:00.000Z'),
    attendees: [],
    sourceUrl: 'https://x.test/p/abc',
  });
  // Offset-carrying instants PLUS the IANA zone: the same guarantee the .ics
  // export makes, so a meeting created here and the event page cannot disagree.
  assert.deepEqual(body.start, { dateTime: '2026-09-16T08:00:00.000Z', timeZone: 'Europe/Madrid' });
  assert.deepEqual(body.end, { dateTime: '2026-09-16T09:30:00.000Z', timeZone: 'Europe/Madrid' });
  assert.equal(body.summary, 'Meeting with Ada');
  assert.equal(String(body.description).includes('https://x.test/p/abc'), true);

  // No end: a zero-length event, never an invented duration.
  const noEnd = buildCalendarEventBody({
    summary: 'x',
    description: null,
    timezone: 'UTC',
    startsAt: new Date('2026-09-16T08:00:00.000Z'),
    endsAt: null,
    attendees: [],
  });
  assert.deepEqual(noEnd.start, noEnd.end);
});

test('calendar: only an event id and a link come back from a created event', () => {
  const parsed = parseCreatedCalendarEvent({
    id: 'evt_123',
    htmlLink: 'https://www.google.com/calendar/event?eid=x',
    // Anything else Google returns (organizer address, attendees, ...) is dropped.
    organizer: { email: 'me@example.com' },
    attendees: [{ email: 'ada@example.com' }],
    iCalUID: 'abc@google.com',
  });
  assert.deepEqual(parsed, { id: 'evt_123', htmlLink: 'https://www.google.com/calendar/event?eid=x' });
  assert.equal(JSON.stringify(parsed).includes('@'), false);
  assert.equal(parseCreatedCalendarEvent({}), null);
  assert.equal(parseCreatedCalendarEvent(null), null);
});

// ---------------------------------------------------------------------------
// Flow status words + the no-storage claim, read from the source
// ---------------------------------------------------------------------------

test('flow status: only the six declared words are accepted, anything else is ignored', () => {
  assert.deepEqual([...GOOGLE_FLOW_STATUSES], [
    'connected',
    'denied',
    'invalid_state',
    'exchange_failed',
    'not_configured',
    'unavailable',
  ]);
  for (const word of GOOGLE_FLOW_STATUSES) assert.equal(isGoogleFlowStatus(word), true);
  assert.equal(isGoogleFlowStatus('<script>alert(1)</script>'), false);
  assert.equal(isGoogleFlowStatus('CONNECTED'), false);
  assert.equal(isGoogleFlowStatus(null), false);
});

test('no third-party contact can be stored: no INSERT into any table in the Google paths', () => {
  // A SOURCE-LEVEL assertion, deliberately: the privacy contract is "this code
  // cannot write a contact", and the strongest available proof of a negative is
  // that no write statement exists in the modules that handle a third party's
  // address book. The runtime half (no row appears anywhere) is
  // tests/integration/google-oauth.test.ts.
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..');

  const files = [
    'src/domain/contact-match.ts',
    'src/lib/google-api.ts',
    'src/lib/oauth-state.ts',
    'src/lib/oauth-pkce.ts',
  ];
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const statement of ['INSERT INTO', 'UPDATE ', 'DELETE FROM']) {
      assert.equal(
        source.includes(statement),
        false,
        `${file} must not contain a write statement (found "${statement}") — a third-party address book may never be persisted`,
      );
    }
  }

  // The match module reads accounts/profiles and writes nothing on its own.
  const match = readFileSync(join(root, 'src/domain/contact-match.ts'), 'utf8');
  assert.ok(match.includes('emailLookupHash'), 'matching must go through the peppered lookup hash');
  assert.equal(/contacts?\b.*(INSERT|VALUES)/i.test(match), false);
});

test('the Google Contacts route normalizes with the SAME function as the address-book import', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', '..');
  const google = readFileSync(join(root, 'src/domain/google-oauth.ts'), 'utf8');
  const importRoute = readFileSync(join(root, 'src/app/api/me/contacts/import/route.ts'), 'utf8');
  const googleRoute = readFileSync(join(root, 'src/app/api/me/contacts/google/route.ts'), 'utf8');

  // One normalization, one lookup hash, one answer to "who is already here".
  assert.ok(google.includes("import { normalizeContactEmail } from './contact-import'"));
  // Both routes go through the shared matcher rather than each having its own SQL.
  assert.ok(importRoute.includes('matchContactEmails'));
  assert.ok(googleRoute.includes('matchContactEmails'));
  assert.equal(googleRoute.includes('FROM accounts'), false, 'the Google route must not carry its own match SQL');
});

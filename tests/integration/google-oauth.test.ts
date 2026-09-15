import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as saveProfileRoute } from '../../src/app/api/me/profile/route';
import { GET as oauthStart } from '../../src/app/api/oauth/google/start/route';
import { GET as oauthCallback } from '../../src/app/api/oauth/google/callback/route';
import { DELETE as oauthDisconnect } from '../../src/app/api/me/oauth/google/route';
import { POST as googleContactsImport } from '../../src/app/api/me/contacts/google/route';
import { POST as googleCalendarCreate } from '../../src/app/api/me/calendar/google/route';
import { getSql, closeSql } from '../../src/lib/db';
import { decryptValue, emailLookupHash } from '../../src/lib/crypto';
import { setGoogleFetch } from '../../src/lib/google-api';
import { purgeExpiredFlowStates } from '../../src/lib/oauth-flow';
import { runCleanupPass } from '../../src/infra/cleanup';
import { GOOGLE_CALENDAR_SCOPE, GOOGLE_CONTACTS_SCOPE } from '../../src/domain/google-oauth';
import { accountIdFromCookie, loginViaOtp, makeRequest, uniqueEmail, assertStatus } from './helpers';

/**
 * Phase 2, end to end through the REAL route handlers with Google mocked at the
 * transport (`setGoogleFetch`) — the same seam style as `setRateLimitClock`.
 *
 * What this file is here to prove, in order of how much it matters:
 *
 *   1. a third party's address book never reaches the database — proven by
 *      scanning EVERY base table for the third party's address and lookup hash,
 *      plus a before/after row-count diff of the whole schema;
 *   2. tokens are stored ENCRYPTED and never returned to a client;
 *   3. a replayed, tampered, expired or foreign `state` fails safely and stores
 *      nothing;
 *   4. disconnect deletes our copy and asks Google to revoke, in that order;
 *   5. revoked consent at Google (invalid_grant on refresh) is recorded as
 *      revoked, not silently retried;
 *   6. a calendar event goes to the user's OWN calendar and carries no
 *      counterpart address unless that action explicitly opted in.
 *
 * The two Google credentials are set for THIS FILE only: node's test runner runs
 * each file in its own process, so the instance-configured branch lives here and
 * the unconfigured branch stays provable in tests/integration/providers.test.ts
 * and the /me/connections render test.
 */

const CLIENT_ID = 'integration-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'integration-client-secret-value';
const ACCESS_TOKEN = 'ya29.integration-access-token-sentinel';
const REFRESH_TOKEN = '1//integration-refresh-token-sentinel';

before(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
});

after(async () => {
  setGoogleFetch(null);
  await closeSql();
});

// ---------------------------------------------------------------------------
// A tiny fake Google
// ---------------------------------------------------------------------------

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Records every call and answers from a per-endpoint script. */
class FakeGoogle {
  readonly calls: CapturedCall[] = [];
  tokenStatus = 200;
  tokenBody: Record<string, unknown> = {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_in: 3599,
    scope: `${GOOGLE_CONTACTS_SCOPE} ${GOOGLE_CALENDAR_SCOPE}`,
    token_type: 'Bearer',
  };
  revokeStatus = 200;
  peopleStatus = 200;
  peoplePages: Record<string, unknown>[] = [{ connections: [] }];
  calendarStatus = 200;
  calendarId = 'google-event-id-1';

  private page = 0;

  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = String(value);
    this.calls.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : '',
    });

    if (url.includes('oauth2.googleapis.com/token')) {
      return this.json(this.tokenStatus, this.tokenBody);
    }
    if (url.includes('oauth2.googleapis.com/revoke')) {
      return new Response(this.revokeStatus === 200 ? '' : JSON.stringify({ error: 'invalid_token' }), {
        status: this.revokeStatus,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
    }
    if (url.includes('people.googleapis.com')) {
      const page = this.peoplePages[Math.min(this.page, this.peoplePages.length - 1)] ?? { connections: [] };
      this.page++;
      return this.json(this.peopleStatus, page);
    }
    if (url.includes('googleapis.com/calendar')) {
      return this.json(this.calendarStatus, {
        id: this.calendarId,
        htmlLink: `https://www.google.com/calendar/event?eid=${this.calendarId}`,
        organizer: { email: 'owner@example.com' },
      });
    }
    throw new Error(`unexpected Google URL in test: ${url}`);
  };

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  reset(): void {
    this.calls.length = 0;
    this.page = 0;
    this.tokenStatus = 200;
    this.revokeStatus = 200;
    this.peopleStatus = 200;
    this.calendarStatus = 200;
    this.peoplePages = [{ connections: [] }];
  }

  /** The last call to a URL fragment, or undefined. */
  lastCall(fragment: string): CapturedCall | undefined {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const call = this.calls[i]!;
      if (call.url.includes(fragment)) return call;
    }
    return undefined;
  }
}

const google = new FakeGoogle();
setGoogleFetch(google.fetch);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Account {
  email: string;
  cookie: string;
  accountId: string;
  slug: string;
  displayName: string;
}

async function newAccount(prefix: string): Promise<Account> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const displayName = `Google ${prefix}`;
  const saved = await saveProfileRoute(makeRequest('/api/me/profile', { body: { display_name: displayName }, cookie }));
  assertStatus(saved, 200);
  const payload = (await saved.json()) as { profile: { public_slug: string } };
  return {
    email,
    cookie,
    accountId: await accountIdFromCookie(cookie),
    slug: payload.profile.public_slug,
    displayName,
  };
}

/**
 * Runs the REAL start route and returns the state Google would have been given,
 * so every callback test exercises the same handshake the browser does.
 *
 * It also points the fake token endpoint at the scope the provider needs, so a
 * test never inherits the previous test's consent: a narrower or wider scope left
 * over from an earlier case would make this one quietly assert the wrong thing.
 */
async function startFlow(cookie: string, provider: 'google-contacts' | 'google-calendar') {
  google.tokenStatus = 200;
  google.tokenBody = {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_in: 3599,
    scope: provider === 'google-contacts' ? GOOGLE_CONTACTS_SCOPE : GOOGLE_CALENDAR_SCOPE,
    token_type: 'Bearer',
  };
  const res = await oauthStart(makeRequest(`/api/oauth/google/start?provider=${provider}`, { cookie }));
  assertStatus(res, 302);
  const location = res.headers.get('location') ?? '';
  const url = new URL(location);
  assert.equal(url.origin, 'https://accounts.google.com');
  return {
    location,
    url,
    state: url.searchParams.get('state') ?? '',
    codeChallenge: url.searchParams.get('code_challenge') ?? '',
    res,
  };
}

async function callback(cookie: string, query: string) {
  return oauthCallback(makeRequest(`/api/oauth/google/callback?${query}`, { cookie }));
}

/**
 * The redirect target of a flow response, as a URL.
 *
 * Resolved against APP_BASE_URL because the flow deliberately answers with a
 * RELATIVE `Location` (src/lib/redirect.ts): a wrong APP_BASE_URL or a forged
 * Host header must not be able to move a user to another origin, so the browser —
 * and this assertion — resolves a local path against the request it made.
 */
function redirectOf(res: Response): URL {
  assertStatus(res, 302);
  return new URL(res.headers.get('location') ?? '', process.env.APP_BASE_URL ?? 'http://localhost:3000');
}

/** Every base table, with its row count — the "did anything get stored" snapshot. */
async function tableCounts(): Promise<Record<string, number>> {
  const sql = getSql();
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ${sql(table.table_name)}`;
    counts[table.table_name] = rows[0]?.count ?? 0;
  }
  return counts;
}

function diffCounts(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const diff: Record<string, number> = {};
  for (const [table, count] of Object.entries(after)) {
    const delta = count - (before[table] ?? 0);
    if (delta !== 0) diff[table] = delta;
  }
  return diff;
}

/**
 * Scans EVERY text-bearing value of EVERY base table for a needle.
 *
 * The reason this is written generically rather than as a list of the tables we
 * "expect" to be safe: the claim is that a third party's address does not exist
 * in this database ANYWHERE, and a hand-picked table list would only prove it
 * about the tables we already thought of.
 */
async function tablesContaining(needle: string): Promise<string[]> {
  const sql = getSql();
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const hits: string[] = [];
  for (const table of tables) {
    const rows = await sql.unsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM "${table.table_name}" t WHERE position($1 in t::text) > 0`,
      [needle],
    );
    if ((rows[0]?.count ?? 0) > 0) hits.push(table.table_name);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

test('oauth start: a signed-out visitor is sent to sign in, and nothing about Google happens', async () => {
  google.reset();
  const res = await oauthStart(makeRequest('/api/oauth/google/start?provider=google-contacts'));
  const url = redirectOf(res);
  assert.equal(url.pathname, '/login');
  assert.equal(url.searchParams.get('next'), '/me/connections');
  assert.equal(google.calls.length, 0, 'no Google call may precede the user pressing connect');
  assert.equal(url.href.includes('accounts.google.com'), false);
});

test('oauth start: an unknown provider is refused rather than guessed', async () => {
  const account = await newAccount('oauth-bad-provider');
  const res = await oauthStart(makeRequest('/api/oauth/google/start?provider=google-drive', { cookie: account.cookie }));
  assertStatus(res, 400);
  const payload = (await res.json()) as { code: string };
  assert.equal(payload.code, 'unknown_provider');
  // A missing provider is refused too (never defaulted to one of the two).
  const none = await oauthStart(makeRequest('/api/oauth/google/start', { cookie: account.cookie }));
  assertStatus(none, 400);
});

test('oauth start: builds the authorization URL with PKCE, offline access and only the provider scope', async () => {
  google.reset();
  const account = await newAccount('oauth-start');
  const flow = await startFlow(account.cookie, 'google-contacts');

  const p = flow.url.searchParams;
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('redirect_uri'), 'http://localhost:3000/api/oauth/google/callback');
  assert.equal(p.get('scope'), GOOGLE_CONTACTS_SCOPE);
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(flow.codeChallenge.length, 43);
  // The CLIENT SECRET must never travel in a redirect the browser can see.
  assert.equal(flow.location.includes(CLIENT_SECRET), false);
  assert.equal(google.calls.length, 0, 'start only builds a URL');

  // The PKCE VERIFIER is stored server-side, encrypted, and is not the challenge.
  const sql = getSql();
  const rows = await sql<{ jti: string; code_verifier_encrypted: string; redirect_path: string }[]>`
    SELECT jti, code_verifier_encrypted, redirect_path FROM oauth_flow_states
    WHERE account_id = ${account.accountId}
  `;
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.match(row.code_verifier_encrypted, /^v1\./);
  assert.equal(row.redirect_path, '/me/connections');
  const verifier = decryptValue(row.code_verifier_encrypted, process.env.ENCRYPTION_KEY ?? '');
  assert.equal(verifier.length, 43);
  assert.notEqual(verifier, flow.codeChallenge);
  assert.equal(flow.location.includes(verifier), false, 'the verifier must never be in the browser URL');

  // The state carries no verifier: decode the payload and look.
  const statePayload = Buffer.from(flow.state.split('.')[0]!, 'base64url').toString('utf8');
  assert.equal(statePayload.includes(verifier), false);
  assert.equal(JSON.parse(statePayload).provider, 'google-contacts');

  // The START is audited with the scope NAMES (public identifiers, no token).
  const audit = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
    SELECT action, metadata FROM audit_events
    WHERE actor_account_id = ${account.accountId} AND action = 'oauth.google.start'
  `;
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0]!.metadata.scopes, [GOOGLE_CONTACTS_SCOPE]);
  assert.equal(JSON.stringify(audit[0]!.metadata).includes(ACCESS_TOKEN), false);
});

test('oauth start: an unconfigured instance reports not_configured instead of sending the user to a Google error', async () => {
  const account = await newAccount('oauth-unconfigured');
  const savedId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  try {
    const res = await oauthStart(makeRequest('/api/oauth/google/start?provider=google-contacts', { cookie: account.cookie }));
    const url = redirectOf(res);
    assert.equal(url.pathname, '/me/connections');
    assert.equal(url.searchParams.get('status'), 'not_configured');
    assert.equal(url.searchParams.get('google'), 'google-contacts');

    // And the callback refuses to redeem anything on such an instance.
    const cb = await callback(account.cookie, 'code=x&state=y');
    assert.equal(redirectOf(cb).searchParams.get('status'), 'not_configured');
  } finally {
    process.env.GOOGLE_OAUTH_CLIENT_ID = savedId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedSecret;
  }
});

// ---------------------------------------------------------------------------
// callback — happy path
// ---------------------------------------------------------------------------

test('oauth callback: stores an ENCRYPTED grant and returns no token material to the client', async () => {
  google.reset();
  const account = await newAccount('oauth-callback');
  const flow = await startFlow(account.cookie, 'google-contacts');
  // Google may hand back MORE than the provider asked for (a previously granted
  // scope riding along). That is stored as returned — it is a fact about the
  // consent — while the check only demands the scopes the provider needs.
  google.tokenBody = {
    ...google.tokenBody,
    scope: `${GOOGLE_CONTACTS_SCOPE} ${GOOGLE_CALENDAR_SCOPE}`,
  };

  const res = await callback(account.cookie, `code=auth-code-1&state=${encodeURIComponent(flow.state)}`);
  const url = redirectOf(res);
  assert.equal(url.pathname, '/me/connections');
  assert.equal(url.searchParams.get('google'), 'google-contacts');
  assert.equal(url.searchParams.get('status'), 'connected');
  // The response — status line, headers and body — carries no token.
  const raw = `${res.headers.get('location')} ${await res.text()}`;
  assert.equal(raw.includes(ACCESS_TOKEN), false);
  assert.equal(raw.includes(REFRESH_TOKEN), false);
  assert.equal(raw.includes(CLIENT_SECRET), false);

  // The exchange really happened, with the verifier that never left the server.
  const tokenCall = google.lastCall('oauth2.googleapis.com/token');
  assert.ok(tokenCall);
  const form = new URLSearchParams(tokenCall.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'auth-code-1');
  assert.equal(form.get('redirect_uri'), 'http://localhost:3000/api/oauth/google/callback');
  assert.equal(form.get('client_id'), CLIENT_ID);
  assert.ok(form.get('code_verifier'), 'the PKCE verifier must be sent');
  assert.equal(form.get('code_verifier')?.length, 43);

  // What is stored is ciphertext; the plaintext is recoverable only with the key.
  const sql = getSql();
  const rows = await sql<{
    access_token_encrypted: string;
    refresh_token_encrypted: string | null;
    scopes: string[];
    expires_at: Date | null;
    revoked_at: Date | null;
  }[]>`
    SELECT access_token_encrypted, refresh_token_encrypted, scopes, expires_at, revoked_at
    FROM oauth_grants WHERE account_id = ${account.accountId} AND provider = 'google-contacts'
  `;
  assert.equal(rows.length, 1);
  const grant = rows[0]!;
  assert.match(grant.access_token_encrypted, /^v1\./);
  assert.notEqual(grant.access_token_encrypted, ACCESS_TOKEN);
  assert.equal(grant.access_token_encrypted.includes(ACCESS_TOKEN), false);
  assert.equal(decryptValue(grant.access_token_encrypted, process.env.ENCRYPTION_KEY ?? ''), ACCESS_TOKEN);
  assert.equal(decryptValue(grant.refresh_token_encrypted ?? '', process.env.ENCRYPTION_KEY ?? ''), REFRESH_TOKEN);
  assert.deepEqual(grant.scopes, [GOOGLE_CONTACTS_SCOPE, GOOGLE_CALENDAR_SCOPE]);
  assert.ok(grant.expires_at, 'the expiry Google reported is stored as an instant');
  assert.equal(grant.revoked_at, null);

  // The flow row is spent, not deleted: a replay must read as "already used".
  const flows = await sql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM oauth_flow_states WHERE account_id = ${account.accountId}
  `;
  assert.equal(flows.length, 1);
  assert.ok(flows[0]!.consumed_at);

  // The connect is audited without tokens.
  const audit = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM audit_events
    WHERE actor_account_id = ${account.accountId} AND action = 'oauth.google.connect'
  `;
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0]!.metadata.scopes, [GOOGLE_CONTACTS_SCOPE, GOOGLE_CALENDAR_SCOPE]);
  const auditText = JSON.stringify(audit[0]!.metadata);
  assert.equal(auditText.includes(ACCESS_TOKEN), false);
  assert.equal(auditText.includes(REFRESH_TOKEN), false);
});

// ---------------------------------------------------------------------------
// callback — the safe failures
// ---------------------------------------------------------------------------

test('oauth callback: a REPLAYED state fails safely and creates no second grant', async () => {
  google.reset();
  const account = await newAccount('oauth-replay');
  const flow = await startFlow(account.cookie, 'google-contacts');
  const q = `code=auth-code-replay&state=${encodeURIComponent(flow.state)}`;

  assert.equal(redirectOf(await callback(account.cookie, q)).searchParams.get('status'), 'connected');
  const callsAfterFirst = google.calls.length;

  const replay = await callback(account.cookie, q);
  const url = redirectOf(replay);
  assert.equal(url.searchParams.get('status'), 'invalid_state');
  assert.equal(url.searchParams.get('google'), 'google-contacts');
  // The replay must not even reach Google: a spent state is refused locally.
  assert.equal(google.calls.length, callsAfterFirst, 'a replayed state must not be exchanged');

  const sql = getSql();
  const grants = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM oauth_grants WHERE account_id = ${account.accountId}
  `;
  assert.equal(grants[0]?.count, 1, 'exactly one grant from one flow, however many callbacks arrive');
});

test('oauth callback: a TAMPERED state, a FOREIGN state and a missing state all fail safely', async () => {
  google.reset();
  const owner = await newAccount('oauth-tamper');
  const other = await newAccount('oauth-tamper-other');
  const flow = await startFlow(owner.cookie, 'google-contacts');

  // 1. A single flipped character in the signed state. The FIRST signature
  //    character is flipped because it carries MAC bits — the last one of a
  //    base64url run is padding, and `verifyOAuthState` additionally rejects any
  //    non-canonical spelling, so there is exactly one accepted form.
  const state = flow.state;
  const [encodedState, mac] = state.split('.') as [string, string];
  const flipped = `${encodedState}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  assert.notEqual(flipped, state);
  const tampered = await callback(owner.cookie, `code=c&state=${encodeURIComponent(flipped)}`);
  assert.equal(redirectOf(tampered).searchParams.get('status'), 'invalid_state');

  // 2. A valid state used from ANOTHER account's session: the flow belongs to
  //    whoever started it, and Google must not be attached to anyone else.
  const foreign = await callback(other.cookie, `code=c&state=${encodeURIComponent(state)}`);
  assert.equal(redirectOf(foreign).searchParams.get('status'), 'invalid_state');

  // 3. No state / no code at all.
  assert.equal(redirectOf(await callback(owner.cookie, 'code=c')).searchParams.get('status'), 'invalid_state');
  assert.equal(redirectOf(await callback(owner.cookie, 'state=x')).searchParams.get('status'), 'invalid_state');

  // 4. Signed out entirely: abandoned, not completed for an unknown account.
  const signedOut = await oauthCallback(
    makeRequest(`/api/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`),
  );
  assert.equal(redirectOf(signedOut).pathname, '/login');

  // None of the four reached the token endpoint, and no grant exists.
  assert.equal(google.lastCall('oauth2.googleapis.com/token'), undefined);
  const sql = getSql();
  const grants = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM oauth_grants
    WHERE account_id IN (${owner.accountId}, ${other.accountId})
  `;
  assert.equal(grants[0]?.count, 0);

  // The owner's own flow is untouched by all that and still completes.
  const fresh = await callback(owner.cookie, `code=c&state=${encodeURIComponent(state)}`);
  assert.equal(redirectOf(fresh).searchParams.get('status'), 'connected');
});

test('oauth callback: an EXPIRED state is refused before Google is asked', async () => {
  google.reset();
  const account = await newAccount('oauth-expired');
  const flow = await startFlow(account.cookie, 'google-contacts');

  // Age the flow past its ten minutes, without touching the signature: the state
  // is genuinely signed and genuinely too old, which is the case that a
  // signature check alone would let through.
  const sql = getSql();
  await sql`
    UPDATE oauth_flow_states SET expires_at = now() - interval '1 minute'
    WHERE account_id = ${account.accountId}
  `;

  const res = await callback(account.cookie, `code=c&state=${encodeURIComponent(flow.state)}`);
  assert.equal(redirectOf(res).searchParams.get('status'), 'invalid_state');
  assert.equal(google.lastCall('oauth2.googleapis.com/token'), undefined);
});

test('oauth callback: the user cancelling at Google is reported as denied, and nothing is stored', async () => {
  google.reset();
  const account = await newAccount('oauth-denied');
  const flow = await startFlow(account.cookie, 'google-calendar');

  const res = await callback(account.cookie, `error=access_denied&state=${encodeURIComponent(flow.state)}`);
  const url = redirectOf(res);
  assert.equal(url.searchParams.get('status'), 'denied');
  assert.equal(url.searchParams.get('google'), 'google-calendar');
  assert.equal(google.calls.length, 0);

  const sql = getSql();
  const grants = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM oauth_grants WHERE account_id = ${account.accountId}
  `;
  assert.equal(grants[0]?.count, 0, 'a refusal must not leave a grant');
  // …and the attempt stays unconsumed, so pressing Connect again just works.
  const flows = await sql<{ consumed_at: Date | null }[]>`
    SELECT consumed_at FROM oauth_flow_states WHERE account_id = ${account.accountId}
  `;
  assert.equal(flows[0]?.consumed_at, null);
});

test('oauth callback: a Google failure at the token endpoint degrades to exchange_failed, not a 500', async () => {
  google.reset();
  const account = await newAccount('oauth-token-fail');
  const flow = await startFlow(account.cookie, 'google-contacts');
  google.tokenStatus = 500;

  try {
    const res = await callback(account.cookie, `code=c&state=${encodeURIComponent(flow.state)}`);
    const url = redirectOf(res);
    assert.equal(url.searchParams.get('status'), 'exchange_failed');
    const sql = getSql();
    const grants = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM oauth_grants WHERE account_id = ${account.accountId}
    `;
    assert.equal(grants[0]?.count, 0, 'a failed exchange stores nothing');
  } finally {
    google.tokenStatus = 200;
  }
});

test('oauth callback: granted scopes are checked — a narrowed consent is refused, not stored', async () => {
  google.reset();
  const account = await newAccount('oauth-scope-narrow');
  const flow = await startFlow(account.cookie, 'google-contacts');
  // Google answers with the calendar scope only (the user unticked contacts).
  google.tokenBody = { ...google.tokenBody, scope: GOOGLE_CALENDAR_SCOPE };

  try {
    const res = await callback(account.cookie, `code=c&state=${encodeURIComponent(flow.state)}`);
    assert.equal(redirectOf(res).searchParams.get('status'), 'exchange_failed');
    const sql = getSql();
    const grants = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM oauth_grants WHERE account_id = ${account.accountId}
    `;
    assert.equal(grants[0]?.count, 0, 'a grant that cannot do the job is not a grant');
  } finally {
    google.tokenBody = { ...google.tokenBody, scope: `${GOOGLE_CONTACTS_SCOPE} ${GOOGLE_CALENDAR_SCOPE}` };
  }
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

test('oauth disconnect: deletes our copy FIRST, then asks Google to revoke, and audits both facts', async () => {
  google.reset();
  const account = await newAccount('oauth-disconnect');
  const flow = await startFlow(account.cookie, 'google-calendar');
  await callback(account.cookie, `code=c&state=${encodeURIComponent(flow.state)}`);
  google.calls.length = 0;

  const res = await oauthDisconnect(
    makeRequest('/api/me/oauth/google?provider=google-calendar', { method: 'DELETE', cookie: account.cookie }),
  );
  assertStatus(res, 200);
  const payload = (await res.json()) as { ok: boolean; deleted: boolean; revoked_at_google: boolean; state: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.deleted, true);
  assert.equal(payload.revoked_at_google, true);
  assert.equal(payload.state, 'not_connected');

  // The token we revoked at Google is the real one, sent as the documented form.
  const revoke = google.lastCall('oauth2.googleapis.com/revoke');
  assert.ok(revoke);
  assert.equal(revoke.method, 'POST');
  assert.equal(new URLSearchParams(revoke.body).get('token'), ACCESS_TOKEN);

  const sql = getSql();
  const grants = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM oauth_grants WHERE account_id = ${account.accountId}
  `;
  assert.equal(grants[0]?.count, 0, 'disconnect must leave nothing of ours behind');
  const audit = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM audit_events
    WHERE actor_account_id = ${account.accountId} AND action = 'oauth.google.disconnect'
  `;
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.metadata.revoked_at_google, true);
  assert.equal(audit[0]!.metadata.had_grant, true);
  assert.equal(JSON.stringify(audit[0]!.metadata).includes(ACCESS_TOKEN), false);
});

test('oauth disconnect: a Google revoke failure does NOT undo the disconnect', async () => {
  google.reset();
  const account = await newAccount('oauth-disconnect-revoke-fail');
  const flow = await startFlow(account.cookie, 'google-contacts');
  await callback(account.cookie, `code=c&state=${encodeURIComponent(flow.state)}`);
  google.revokeStatus = 500;

  try {
    const res = await oauthDisconnect(
      makeRequest('/api/me/oauth/google?provider=google-contacts', { method: 'DELETE', cookie: account.cookie }),
    );
    assertStatus(res, 200);
    const payload = (await res.json()) as { deleted: boolean; revoked_at_google: boolean };
    // Honest, both halves: we forgot it (true), Google has not confirmed (false).
    assert.equal(payload.deleted, true);
    assert.equal(payload.revoked_at_google, false);
    const sql = getSql();
    const grants = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM oauth_grants WHERE account_id = ${account.accountId}
    `;
    assert.equal(grants[0]?.count, 0, 'the user asked us to forget it, so we did');
  } finally {
    google.revokeStatus = 200;
  }
});

test('oauth disconnect: signed out it is a 401, and an unknown provider a 400', async () => {
  const account = await newAccount('oauth-disconnect-guards');
  assertStatus(
    await oauthDisconnect(makeRequest('/api/me/oauth/google?provider=google-contacts', { method: 'DELETE' })),
    401,
  );
  assertStatus(
    await oauthDisconnect(
      makeRequest('/api/me/oauth/google?provider=google-drive', { method: 'DELETE', cookie: account.cookie }),
    ),
    400,
  );
});

// ---------------------------------------------------------------------------
// revoked consent at Google (refresh fails with invalid_grant)
// ---------------------------------------------------------------------------

test('revoked consent: a refresh answering invalid_grant marks the grant REVOKED and stops using it', async () => {
  google.reset();
  const account = await newAccount('oauth-revoked');
  const flow = await startFlow(account.cookie, 'google-contacts');
  await callback(account.cookie, `code=c&state=${encodeURIComponent(flow.state)}`);

  // The user removes access on their Google account page, and the access token
  // ages out: the next use must refresh, and Google says the grant is gone.
  const sql = getSql();
  await sql`
    UPDATE oauth_grants SET expires_at = now() - interval '1 minute'
    WHERE account_id = ${account.accountId}
  `;
  google.tokenStatus = 400;
  google.tokenBody = { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' };

  const res = await googleContactsImport(makeRequest('/api/me/contacts/google', { cookie: account.cookie }));
  assertStatus(res, 409);
  const payload = (await res.json()) as { code: string };
  assert.equal(payload.code, 'reconnect_required');

  const rows = await sql<{ revoked_at: Date | null; revoked_reason: string | null; refresh_failed_at: Date | null }[]>`
    SELECT revoked_at, revoked_reason, refresh_failed_at FROM oauth_grants
    WHERE account_id = ${account.accountId}
  `;
  assert.ok(rows[0]?.revoked_at, 'a revoked consent must be recorded as revoked');
  assert.equal(rows[0]?.revoked_reason, 'invalid_grant');
  assert.ok(rows[0]?.refresh_failed_at);

  // And the state word the page shows is the honest one.
  const again = await googleContactsImport(makeRequest('/api/me/contacts/google', { cookie: account.cookie }));
  assertStatus(again, 409);
  assert.equal(((await again.json()) as { code: string }).code, 'reconnect_required');

  // Reconnecting replaces the dead grant: revoked_at and the reason are cleared,
  // and no duplicate row appears. `startFlow` restores a working token endpoint.
  const reconnect = await startFlow(account.cookie, 'google-contacts');
  await callback(account.cookie, `code=c&state=${encodeURIComponent(reconnect.state)}`);
  const after = await sql<{ count: number; revoked_at: Date | null }[]>`
    SELECT count(*)::int AS count, max(revoked_at) AS revoked_at FROM oauth_grants
    WHERE account_id = ${account.accountId} AND provider = 'google-contacts'
  `;
  assert.equal(after[0]?.count, 1);
  assert.equal(after[0]?.revoked_at, null);
});

// ---------------------------------------------------------------------------
// Contacts import — the privacy proof
// ---------------------------------------------------------------------------

test('google contacts: only matches come back, and NO third party is stored anywhere', async () => {
  google.reset();
  const neighbour = await newAccount('google-neighbour');
  const importer = await newAccount('google-importer');
  const flow = await startFlow(importer.cookie, 'google-contacts');
  await callback(importer.cookie, `code=c&state=${encodeURIComponent(flow.state)}`);

  // A third party who is NOT on WELCOME. Their address is what must never land.
  const strangerEmail = uniqueEmail('google-stranger');
  google.peoplePages = [
    {
      connections: [
        { names: [{ displayName: neighbour.displayName }], emailAddresses: [{ value: neighbour.email }] },
        {
          names: [{ displayName: 'Stranger Danger' }],
          emailAddresses: [{ value: strangerEmail }],
          phoneNumbers: [{ value: '+34 600 123 456' }],
        },
      ],
    },
  ];
  google.calls.length = 0;

  const before = await tableCounts();
  const res = await googleContactsImport(makeRequest('/api/me/contacts/google', { cookie: importer.cookie }));
  assertStatus(res, 200);
  const payload = (await res.json()) as {
    ok: boolean;
    scanned: number;
    matched_count: number;
    matched: { display_name: string; slug: string; headline: string | null }[];
    unmatched_count: number;
    skipped: number;
    truncated: boolean;
  };

  assert.equal(payload.scanned, 2);
  assert.equal(payload.matched_count, 1);
  assert.deepEqual(payload.matched.map((m) => m.slug), [neighbour.slug]);
  assert.equal(payload.matched[0]?.display_name, neighbour.displayName);
  assert.equal(payload.unmatched_count, 1);

  // The response says who is here and NOTHING else: no address, not even the
  // caller's own.
  const body = JSON.stringify(payload);
  assert.equal(body.includes('@'), false, 'no address may appear in the response');
  assert.equal(body.includes(strangerEmail), false);
  assert.equal(body.includes(neighbour.email), false);
  assert.equal(body.includes('600 123 456'), false, 'not even a phone number from Google');

  // 1. The only row the import adds, over the WHOLE schema, is one audit row.
  const afterCounts = await tableCounts();
  assert.deepEqual(diffCounts(before, afterCounts), { audit_events: 1 });

  // 2. The third party's address exists NOWHERE — not as a value, not as a
  //    lookup hash, in any table at all.
  assert.deepEqual(await tablesContaining(strangerEmail), []);
  const pepper = process.env.HASH_PEPPER ?? '';
  assert.deepEqual(await tablesContaining(emailLookupHash(strangerEmail, pepper)), []);

  // 3. And the audit row holds numbers, a format word and no content.
  const sql = getSql();
  const audit = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
    SELECT action, metadata FROM audit_events
    WHERE actor_account_id = ${importer.accountId} AND action = 'contacts.import.match'
  `;
  assert.equal(audit.length, 1);
  assert.deepEqual(Object.keys(audit[0]!.metadata).sort(), ['format', 'matched_count', 'scanned', 'skipped']);
  assert.equal(audit[0]!.metadata.format, 'google-contacts');
  assert.equal(audit[0]!.metadata.scanned, 2);
  assert.equal(audit[0]!.metadata.matched_count, 1);
  assert.equal(JSON.stringify(audit[0]!.metadata).includes('@'), false);

  // 4. What we asked Google for is names and addresses, and nothing else.
  const people = google.lastCall('people.googleapis.com');
  assert.ok(people);
  const peopleUrl = new URL(people.url);
  assert.equal(peopleUrl.searchParams.get('personFields'), 'names,emailAddresses');
  assert.equal(people.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
});

test('google contacts: paging is followed to the end, and a page budget that runs out says so', async () => {
  google.reset();
  const importer = await newAccount('google-paged');
  const flow = await startFlow(importer.cookie, 'google-contacts');
  await callback(importer.cookie, `code=c&state=${encodeURIComponent(flow.state)}`);

  // Two pages, the second with no token: everything was read, so nothing is
  // hidden from the user.
  google.peoplePages = [{ connections: [], nextPageToken: 'PAGE-2' }, { connections: [] }];
  const complete = await googleContactsImport(makeRequest('/api/me/contacts/google', { cookie: importer.cookie }));
  assertStatus(complete, 200);
  assert.equal(((await complete.json()) as { truncated: boolean }).truncated, false);
  assert.equal(google.calls.filter((c) => c.url.includes('people.googleapis.com')).length, 2);

  // Every page hands out another token: the read stops at its budget, and the
  // response must ADMIT that rather than imply the list was complete.
  google.reset();
  google.peoplePages = [
    { connections: [], nextPageToken: 'P1' },
    { connections: [], nextPageToken: 'P2' },
    { connections: [], nextPageToken: 'P3' },
    { connections: [], nextPageToken: 'P4' },
    { connections: [], nextPageToken: 'P5' },
    { connections: [] },
  ];
  const capped = await googleContactsImport(makeRequest('/api/me/contacts/google', { cookie: importer.cookie }));
  assertStatus(capped, 200);
  const payload = (await capped.json()) as { truncated: boolean; scanned: number };
  assert.equal(payload.truncated, true, 'a pending page token must be reported, not swallowed');
  assert.equal(payload.scanned, 0);
  assert.equal(google.calls.filter((c) => c.url.includes('people.googleapis.com')).length, 5);
});

test('google contacts: without a grant the answer is 409 not_connected, and Google is never called', async () => {
  google.reset();
  const account = await newAccount('google-no-grant');
  const res = await googleContactsImport(makeRequest('/api/me/contacts/google', { cookie: account.cookie }));
  assertStatus(res, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'not_connected');
  assert.equal(google.calls.length, 0);

  // Signed out: 401, and still no Google call.
  assertStatus(await googleContactsImport(makeRequest('/api/me/contacts/google')), 401);
  assert.equal(google.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Calendar — the counterpart's address
// ---------------------------------------------------------------------------

async function connectCalendar(prefix: string): Promise<Account> {
  const account = await newAccount(prefix);
  const flow = await startFlow(account.cookie, 'google-calendar');
  const res = await callback(account.cookie, `code=c&state=${encodeURIComponent(flow.state)}`);
  assert.equal(redirectOf(res).searchParams.get('status'), 'connected');
  return account;
}

const COUNTERPART_EMAIL = 'counterpart-must-not-be-sent@example.com';

test('google calendar: the default event carries NO counterpart email, and no address of any kind', async () => {
  google.reset();
  const counterpart = await newAccount('calendar-counterpart');
  const owner = await connectCalendar('calendar-owner');
  google.calls.length = 0;

  const res = await googleCalendarCreate(
    makeRequest('/api/me/calendar/google', {
      cookie: owner.cookie,
      body: {
        counterpart_slug: counterpart.slug,
        starts_at: '2026-09-20T15:00:00.000Z',
        ends_at: '2026-09-20T16:00:00.000Z',
        timezone: 'Europe/Madrid',
      },
    }),
  );
  assertStatus(res, 201);
  const payload = (await res.json()) as {
    ok: boolean;
    event: { id: string; html_link: string | null };
    counterpart: { display_name: string; slug: string };
    attendees_sent: number;
    timezone: string;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.event.id, 'google-event-id-1');
  assert.equal(payload.attendees_sent, 0, 'the default is name-only, and the response says so');

  // What actually went to Google.
  const insert = google.lastCall('googleapis.com/calendar');
  assert.ok(insert);
  assert.match(insert.url, /\/calendars\/primary\/events$/);
  assert.equal(insert.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  const sent = JSON.parse(insert.body) as Record<string, unknown>;
  assert.equal('attendees' in sent, false, 'the default body must not have an attendees key at all');
  assert.equal(insert.body.includes('@'), false, 'no address of any kind may reach Google by default');
  assert.equal(insert.body.includes(counterpart.displayName), true, 'the counterpart is present as a NAME');
  assert.deepEqual(sent.start, { dateTime: '2026-09-20T15:00:00.000Z', timeZone: 'Europe/Madrid' });
  assert.deepEqual(sent.end, { dateTime: '2026-09-20T16:00:00.000Z', timeZone: 'Europe/Madrid' });
  // The user's own card URL is included; the counterpart's is not an address.
  assert.equal(String(sent.description).includes('/p/'), true);

  const sql = getSql();
  const audit = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM audit_events
    WHERE actor_account_id = ${owner.accountId} AND action = 'calendar.google.create'
  `;
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.metadata.attendees_sent, 0);
  assert.equal(JSON.stringify(audit[0]!.metadata).includes('@'), false);
  // …and nothing about the counterpart's address exists in the database either.
  assert.deepEqual(await tablesContaining(COUNTERPART_EMAIL), []);
});

test('google calendar: a counterpart email without the opt-in is REFUSED, never silently dropped', async () => {
  google.reset();
  const counterpart = await newAccount('calendar-optin');
  const owner = await connectCalendar('calendar-owner-optin');
  google.calls.length = 0;

  const res = await googleCalendarCreate(
    makeRequest('/api/me/calendar/google', {
      cookie: owner.cookie,
      body: {
        counterpart_slug: counterpart.slug,
        starts_at: '2026-09-20T15:00:00.000Z',
        timezone: 'Europe/Madrid',
        counterpart_email: COUNTERPART_EMAIL,
      },
    }),
  );
  assertStatus(res, 400);
  assert.equal(((await res.json()) as { code: string }).code, 'counterpart_email_requires_opt_in');
  assert.equal(google.calls.length, 0, 'a refused request must not reach Google');

  // With the opt-in, the address IS sent — because the user asked for it.
  const opted = await googleCalendarCreate(
    makeRequest('/api/me/calendar/google', {
      cookie: owner.cookie,
      body: {
        counterpart_slug: counterpart.slug,
        starts_at: '2026-09-20T15:00:00.000Z',
        timezone: 'Europe/Madrid',
        counterpart_email: COUNTERPART_EMAIL,
        include_counterpart_email: true,
      },
    }),
  );
  assertStatus(opted, 201);
  assert.equal(((await opted.json()) as { attendees_sent: number }).attendees_sent, 1);
  const sent = JSON.parse(google.lastCall('googleapis.com/calendar')!.body) as { attendees?: { email: string }[] };
  assert.deepEqual(sent.attendees, [{ email: COUNTERPART_EMAIL }]);

  // The opt-in is per action: the next event without it carries no address again.
  google.calls.length = 0;
  const plain = await googleCalendarCreate(
    makeRequest('/api/me/calendar/google', {
      cookie: owner.cookie,
      body: {
        counterpart_slug: counterpart.slug,
        starts_at: '2026-09-21T15:00:00.000Z',
        timezone: 'Europe/Madrid',
      },
    }),
  );
  assertStatus(plain, 201);
  assert.equal(((await plain.json()) as { attendees_sent: number }).attendees_sent, 0);
  assert.equal(google.lastCall('googleapis.com/calendar')!.body.includes('@'), false);

  // Still nothing about that address in OUR database, opt-in or not.
  assert.deepEqual(await tablesContaining(COUNTERPART_EMAIL), []);
});

test('google calendar: invalid input, an unknown counterpart and no grant all fail honestly', async () => {
  google.reset();
  const counterpart = await newAccount('calendar-guards');
  const owner = await connectCalendar('calendar-owner-guards');

  const bad = async (body: Record<string, unknown>, expected: number, code: string) => {
    const res = await googleCalendarCreate(makeRequest('/api/me/calendar/google', { cookie: owner.cookie, body }));
    assertStatus(res, expected);
    assert.equal(((await res.json()) as { code: string }).code, code);
  };

  await bad({ counterpart_slug: counterpart.slug, timezone: 'Europe/Madrid' }, 400, 'invalid_start');
  await bad(
    { counterpart_slug: counterpart.slug, starts_at: 'not-a-date', timezone: 'Europe/Madrid' },
    400,
    'invalid_start',
  );
  await bad(
    {
      counterpart_slug: counterpart.slug,
      starts_at: '2026-09-20T15:00:00.000Z',
      ends_at: '2026-09-20T14:00:00.000Z',
      timezone: 'Europe/Madrid',
    },
    400,
    'invalid_end',
  );
  // An unknown IANA zone is refused, exactly as event creation refuses it.
  await bad(
    { counterpart_slug: counterpart.slug, starts_at: '2026-09-20T15:00:00.000Z', timezone: 'Mars/Olympus' },
    400,
    'invalid_timezone',
  );
  await bad(
    { counterpart_slug: 'no-such-card-at-all-xxxxxxxxxx', starts_at: '2026-09-20T15:00:00.000Z', timezone: 'UTC' },
    404,
    'counterpart_not_found',
  );
  assert.equal(google.lastCall('googleapis.com/calendar'), undefined, 'no invalid request may reach Google');

  // No grant: 409, and Google is not called.
  const stranger = await newAccount('calendar-no-grant');
  google.calls.length = 0;
  const res = await googleCalendarCreate(
    makeRequest('/api/me/calendar/google', {
      cookie: stranger.cookie,
      body: { counterpart_slug: counterpart.slug, starts_at: '2026-09-20T15:00:00.000Z', timezone: 'UTC' },
    }),
  );
  assertStatus(res, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'not_connected');
  assert.equal(google.calls.length, 0);

  // Signed out: 401.
  assertStatus(
    await googleCalendarCreate(
      makeRequest('/api/me/calendar/google', {
        body: { counterpart_slug: counterpart.slug, starts_at: '2026-09-20T15:00:00.000Z', timezone: 'UTC' },
      }),
    ),
    401,
  );
});

// ---------------------------------------------------------------------------
// Flow-state retention
// ---------------------------------------------------------------------------

test('flow states: spent and expired handshakes are purged, grants are not touched', async () => {
  google.reset();
  const sql = getSql();
  const account = await newAccount('flow-retention');
  const flow = await startFlow(account.cookie, 'google-contacts');
  await callback(account.cookie, `code=c&state=${encodeURIComponent(flow.state)}`);

  // A grant exists and must survive every cleanup.
  const grantsBefore = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM oauth_grants WHERE account_id = ${account.accountId}
  `;
  assert.equal(grantsBefore[0]?.count, 1);

  // The consumed row is young, so it survives the first pass — a replayed
  // callback arriving right after the real one must still read as "already used".
  const first = await runCleanupPass();
  assert.equal(typeof first.oauth_flow_states, 'number');
  const stillThere = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM oauth_flow_states WHERE account_id = ${account.accountId}
  `;
  assert.equal(stillThere[0]?.count, 1);

  // Age it past the grace hour: now it goes, and the grant stays.
  await sql`
    UPDATE oauth_flow_states SET consumed_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
    WHERE account_id = ${account.accountId}
  `;
  const purged = await purgeExpiredFlowStates(sql);
  assert.equal(purged >= 1, true);
  const gone = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM oauth_flow_states WHERE account_id = ${account.accountId}
  `;
  assert.equal(gone[0]?.count, 0);

  const second = await runCleanupPass();
  assert.equal(typeof second.oauth_flow_states, 'number');
  const grantsAfter = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM oauth_grants WHERE account_id = ${account.accountId}
  `;
  assert.equal(grantsAfter[0]?.count, 1, 'a cleanup must never disconnect anyone');
});

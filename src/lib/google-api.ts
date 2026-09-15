/**
 * The ONLY module that talks to Google (People + Calendar + OAuth token/revoke).
 *
 * Everything above it — routes, the connections page — sees either a typed
 * success value or a `GoogleApiError` carrying a `GoogleApiErrorCode`; never a
 * Response, never a raw body. That is deliberate:
 *
 *   - nothing above can accidentally log or forward a token response, because
 *     the raw body never leaves this file;
 *   - "a Google call failed" is a typed, testable outcome, so a route can degrade
 *     honestly instead of throwing a 500 (project brief).
 *
 * NO NEW DEPENDENCY: token exchange, refresh, revoke, `people/me/connections` and
 * `calendars/primary/events` are all plain `fetch` calls with
 * `application/x-www-form-urlencoded` bodies, per Google's own documentation.
 *
 * TEST SEAM: `setGoogleFetch` swaps the transport (same shape as the existing
 * `setRateLimitClock` in src/lib/ratelimit.ts), so the integration suite drives
 * the whole flow — callback, import, calendar — with a mocked Google and no
 * network. The default is the global fetch and there is no other way to inject
 * one, so production code cannot be pointed at a different host by a caller.
 */

import {
  GOOGLE_CALENDAR_EVENTS_ENDPOINT,
  GOOGLE_PEOPLE_CONNECTIONS_ENDPOINT,
  GOOGLE_PERSON_FIELDS,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_CONTACTS_PAGE_SIZE,
  classifyGoogleHttpError,
  parseCreatedCalendarEvent,
  parseGoogleErrorBody,
  parseGoogleTokenResponse,
  type CreatedCalendarEvent,
  type GoogleApiErrorCode,
  type GoogleTokenSet,
} from '../domain/google-oauth';

/** A typed Google failure. `code` is the only thing callers act on. */
export class GoogleApiError extends Error {
  readonly code: GoogleApiErrorCode;
  /** HTTP status, or null when the request never completed. */
  readonly status: number | null;

  constructor(code: GoogleApiErrorCode, status: number | null = null) {
    // The message is the CODE, never Google's text: their error strings can echo
    // the request, and this message ends up in server logs.
    super(`google_api_${code}`);
    this.name = 'GoogleApiError';
    this.code = code;
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let transport: FetchLike = (input, init) => fetch(input, init);

/**
 * Test-only transport override. Passing `null` restores the real fetch.
 * Not exported to routes: they always call the wrappers below.
 */
export function setGoogleFetch(next: FetchLike | null): void {
  transport = next ?? ((input, init) => fetch(input, init));
}

/** Timeout for every Google call: a hanging consent exchange must not hang a
 * callback forever. AbortSignal.timeout is built in — no dependency. */
const GOOGLE_TIMEOUT_MS = 10_000;

/** Reads the body once, tolerating a non-JSON/empty body without throwing. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One HTTP call with the shared timeout + error classification. */
async function callGoogle(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await transport(url, { ...init, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
  } catch {
    // Deliberately swallowed: a transport error's message can contain the URL
    // (with a client_id) and is never useful to a caller.
    throw new GoogleApiError('network_error', null);
  }
  const body = await readBody(res);
  if (!res.ok) {
    throw new GoogleApiError(classifyGoogleHttpError(res.status, body), res.status);
  }
  return body;
}

// ---------------------------------------------------------------------------
// OAuth token endpoints
// ---------------------------------------------------------------------------

export interface TokenRequestBase {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Exchanges an authorization code for tokens. The code is single-use at Google
 * too, so a second call with the same code comes back `invalid_grant`.
 */
export async function exchangeAuthorizationCode(
  input: TokenRequestBase & { code: string; codeVerifier: string },
): Promise<GoogleTokenSet> {
  const form = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri,
  });
  const body = await callGoogle(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const tokens = parseGoogleTokenResponse(body);
  if (tokens === null) {
    // 2xx with nothing usable: reported as malformed rather than as a grant with
    // an empty access token in it.
    throw new GoogleApiError('malformed_response', 200);
  }
  return tokens;
}

/**
 * Renews an access token. Google returns NO refresh token here — the caller
 * keeps the one it already stored (see `upsertGrant`).
 */
export async function refreshAccessToken(
  input: TokenRequestBase & { refreshToken: string },
): Promise<GoogleTokenSet> {
  const form = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });
  const body = await callGoogle(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const tokens = parseGoogleTokenResponse(body);
  if (tokens === null) throw new GoogleApiError('malformed_response', 200);
  return tokens;
}

/**
 * Best-effort revocation at Google (the disconnect endpoint). Throws a typed
 * error like every other call — the CALLER decides that a failure here must not
 * stop the local deletion, which is the honest order: our copy goes first.
 */
export async function revokeGoogleToken(token: string): Promise<void> {
  const form = new URLSearchParams({ token });
  await callGoogle(GOOGLE_REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
}

// ---------------------------------------------------------------------------
// People API
// ---------------------------------------------------------------------------

export interface PeoplePage {
  payload: unknown;
  /** `pageToken` to pass to the next call, or null on the last page. */
  nextPageToken: string | null;
}

/**
 * One page of `people/me/connections`, with ONLY `names,emailAddresses`
 * requested. Asking for less is the point: the field mask is the request's
 * contract with Google, not just an optimisation.
 */
export async function listPeopleConnectionsPage(
  accessToken: string,
  opts: { pageToken?: string | null; pageSize?: number } = {},
): Promise<PeoplePage> {
  const url = new URL(GOOGLE_PEOPLE_CONNECTIONS_ENDPOINT);
  url.searchParams.set('personFields', GOOGLE_PERSON_FIELDS);
  url.searchParams.set('pageSize', String(opts.pageSize ?? GOOGLE_CONTACTS_PAGE_SIZE));
  if (opts.pageToken) url.searchParams.set('pageToken', opts.pageToken);

  const payload = await callGoogle(url.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const nextPageToken =
    typeof payload === 'object' && payload !== null && typeof (payload as Record<string, unknown>).nextPageToken === 'string'
      ? ((payload as Record<string, unknown>).nextPageToken as string)
      : null;
  return { payload, nextPageToken };
}

// ---------------------------------------------------------------------------
// Calendar API
// ---------------------------------------------------------------------------

/**
 * Creates an event in the user's OWN calendar (`calendars/primary`).
 *
 * The counterpart's address can only be in `body.attendees`, which the caller
 * builds with `googleCalendarAttendees(...)` — see the privacy note there. This
 * function does not look at addresses at all; it posts the body it is given.
 */
export async function createCalendarEvent(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<CreatedCalendarEvent> {
  const payload = await callGoogle(GOOGLE_CALENDAR_EVENTS_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const event = parseCreatedCalendarEvent(payload);
  if (event === null) throw new GoogleApiError('malformed_response', 200);
  return event;
}

/** Re-exported for callers that only need to read a Google error body in a test. */
export { parseGoogleErrorBody };

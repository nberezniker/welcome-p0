/**
 * Google OAuth 2.0 (PKCE) + People/Calendar payload shapes — the PURE half of
 * Phase 2 of docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md (§A3, §C).
 *
 * Everything here is a function of its arguments: no database, no network, no
 * `process.env`, no sentences. The HTTP lives in src/lib/google-api.ts, the
 * stored grant in src/lib/oauth-grants.ts, and the routes compose them — which
 * is what lets the unit suite prove the scope list, the authorization URL shape
 * and the "who gets the counterpart's email" rule without a Google server.
 *
 * Three rules are encoded structurally rather than in comments:
 *
 *   1. SCOPES ARE PER PROVIDER AND CLOSED. `google-contacts` asks for
 *      `contacts.readonly` and `google-calendar` asks for `calendar.events` —
 *      never Gmail, Drive, or the read-WRITE contacts scope. The map below is
 *      the only place a scope string appears, and the unit suite pins it, so
 *      widening what we ask for is a deliberate, reviewable edit.
 *
 *   2. THE COUNTERPART'S EMAIL IS OPT-IN, PER ACTION. `googleCalendarAttendees`
 *      is the ONLY function that can produce an attendee list, and it returns
 *      `[]` unless the caller passes an explicit `optIn` for THIS action
 *      (design §C, project brief). Default is therefore "the counterpart's
 *      display name in the event text, no address sent to Google".
 *
 *   3. A GRANT'S STATE IS DERIVED FROM FACTS, NEVER STORED. `googleGrantState`
 *      reads expiry / refresh-failure / revocation and answers with one of four
 *      honest words, so there is no status column that could drift away from
 *      what the tokens actually are.
 */

import { normalizeContactEmail } from './contact-import';
import type { ProviderId } from './providers';

/** The two registry rows this module serves. */
export const GOOGLE_OAUTH_PROVIDERS = ['google-contacts', 'google-calendar'] as const;
export type GoogleOAuthProvider = (typeof GOOGLE_OAUTH_PROVIDERS)[number];

export function isGoogleOAuthProvider(value: unknown): value is GoogleOAuthProvider {
  return typeof value === 'string' && (GOOGLE_OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The redirect path, exactly as registered on the Google OAuth client
 * (`welcome-web`, project `my-project-48009welcome-p0`). The deployed flow and
 * the registered URI must stay byte-identical, so this constant is the single
 * source of truth for it (docs-internal/product/GOOGLE_OAUTH_SETUP.md).
 */
export const GOOGLE_REDIRECT_PATH = '/api/oauth/google/callback';

/**
 * The absolute redirect URI for a deployment base URL.
 *
 * Both the `start` route (which puts it in `redirect_uri`) and the `callback`
 * route (which sends it to the token endpoint) must use THIS function: the two
 * values have to be byte-identical to each other and to the URI registered on the
 * OAuth client, and three copies of a string concat is how that stops being true.
 * A trailing slash on APP_BASE_URL must not produce a double slash — Google
 * compares redirect URIs literally.
 */
export function googleRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${GOOGLE_REDIRECT_PATH}`;
}

export const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_PEOPLE_CONNECTIONS_ENDPOINT =
  'https://people.googleapis.com/v1/people/me/connections';
export const GOOGLE_CALENDAR_EVENTS_ENDPOINT =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** Read-only contacts list. NOT `.../auth/contacts` (read-write): we never write. */
export const GOOGLE_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
/** Create/update events on the user's own calendar. Nothing else on the calendar. */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * Exactly what each provider asks for. A provider id missing from this map
 * cannot start a flow at all (`scopesForProvider` returns null), which is what
 * keeps a future provider from silently inheriting Google scopes.
 */
export const GOOGLE_SCOPES: Readonly<Record<GoogleOAuthProvider, readonly string[]>> = Object.freeze({
  'google-contacts': Object.freeze([GOOGLE_CONTACTS_SCOPE]),
  'google-calendar': Object.freeze([GOOGLE_CALENDAR_SCOPE]),
});

/** Scopes for a provider, or null when it is not a Google provider. */
export function scopesForProvider(provider: string): readonly string[] | null {
  return isGoogleOAuthProvider(provider) ? GOOGLE_SCOPES[provider] : null;
}

/** True when a provider id belongs to Google (used by the UI copy switches). */
export function isGoogleProviderId(id: ProviderId): id is GoogleOAuthProvider {
  return isGoogleOAuthProvider(id);
}

/** How long an authorization attempt stays valid. Short by design: it is a
 * handshake, not a record (see the oauth_flow_states note in migration 013). */
export const GOOGLE_OAUTH_STATE_TTL_SECONDS = 600;

/** Where the OAuth flow reports back to — the page with the connect controls. */
export const CONNECTIONS_PATH = '/me/connections';

/**
 * The complete set of outcomes the flow can report to that page, as short
 * machine-readable words. It lives in the domain because THREE places must agree
 * on it: the two routes that produce a flag and the page that renders it. A word
 * outside this list is ignored by the page (an unknown status renders as "no
 * news"), so a stale bookmarked URL can never display someone else's outcome.
 */
export const GOOGLE_FLOW_STATUSES = [
  /** Grant stored. */
  'connected',
  /** The user pressed "cancel"/denied on Google's consent screen. */
  'denied',
  /** The state was tampered with, replayed, or past its 10 minutes. */
  'invalid_state',
  /** Consent given, but the code exchange failed (Google-side or ours). */
  'exchange_failed',
  /** This instance has no Google OAuth client, so nothing could be started. */
  'not_configured',
  /** An unexpected failure; the honest catch-all, never a silent success. */
  'unavailable',
] as const;

export type GoogleFlowStatus = (typeof GOOGLE_FLOW_STATUSES)[number];

export function isGoogleFlowStatus(value: unknown): value is GoogleFlowStatus {
  return typeof value === 'string' && (GOOGLE_FLOW_STATUSES as readonly string[]).includes(value);
}

export interface BuildAuthorizationUrlInput {
  clientId: string;
  /** Absolute redirect URI: base + GOOGLE_REDIRECT_PATH. */
  redirectUri: string;
  provider: GoogleOAuthProvider;
  /** Signed, single-use state (src/lib/oauth-state.ts). */
  state: string;
  /** S256 PKCE challenge (src/lib/oauth-pkce.ts). */
  codeChallenge: string;
}

/**
 * The authorization URL the browser is sent to.
 *
 * `access_type=offline` + `prompt=consent` are the pair that makes Google return
 * a REFRESH token: without `prompt=consent` a second connection by the same user
 * comes back without one, and the grant would expire irrecoverably. The cost —
 * the consent screen appears every time — is paid deliberately.
 *
 * `code_challenge_method=S256` (never `plain`) because the verifier is what
 * proves the code came back to the client that asked for it.
 */
export function buildGoogleAuthorizationUrl(input: BuildAuthorizationUrlInput): string {
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES[input.provider].join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'false');
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token endpoint payloads
// ---------------------------------------------------------------------------

export interface GoogleTokenSet {
  accessToken: string;
  /** Null when Google did not return one (see prompt=consent above). */
  refreshToken: string | null;
  /** `scope` is a space-separated string in Google's response; split here. */
  scopes: string[];
  tokenType: string | null;
  /** Absolute expiry, from `expires_in`; null when Google omitted it. */
  expiresAt: Date | null;
}

/**
 * Parses a successful token response (both the code exchange and a refresh go
 * through it). Returns null on a payload that is not usable — a missing access
 * token is a failure, not a grant with an empty string in it.
 *
 * A refresh response carries NO refresh token; the sql layer keeps the one it
 * already has (see `upsertGrant`), so null here means "unchanged", not "gone".
 */
export function parseGoogleTokenResponse(payload: unknown, now: Date = new Date()): GoogleTokenSet | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;

  const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token.length > 0
    ? body.refresh_token
    : null;
  const tokenType = typeof body.token_type === 'string' && body.token_type.length > 0 ? body.token_type : null;

  const scopes = typeof body.scope === 'string'
    ? body.scope.split(/\s+/).filter((scope) => scope.length > 0)
    : [];

  const expiresIn = typeof body.expires_in === 'number'
    ? body.expires_in
    : typeof body.expires_in === 'string' && /^\d+$/.test(body.expires_in)
      ? Number(body.expires_in)
      : null;
  const expiresAt = expiresIn !== null && expiresIn > 0
    ? new Date(now.getTime() + expiresIn * 1000)
    : null;

  return { accessToken, refreshToken, scopes, tokenType, expiresAt };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Machine-readable failure classes. Routes map these to HTTP statuses and audit
 * metadata; the UI maps them to localized sentences — no Google error string
 * ever travels further than the parser (they can echo the request).
 */
export type GoogleApiErrorCode =
  /** The grant is gone: user revoked us, or the code/token was already used. */
  | 'invalid_grant'
  /** We sent something Google refused (bad client, bad redirect, bad scope). */
  | 'invalid_request'
  /** 401 without a recognizable error body. */
  | 'unauthorized'
  /** 403: the scope is missing or the API is disabled for this project. */
  | 'forbidden'
  /** 429 — quota. Worth retrying later, not now. */
  | 'rate_limited'
  /** 5xx from Google: their problem, and honestly reported as such. */
  | 'server_error'
  /** We never reached Google. */
  | 'network_error'
  /** 2xx with an unusable body. */
  | 'malformed_response';

export interface GoogleErrorBody {
  error: string | null;
  description: string | null;
}

/** Extracts Google's OAuth error fields without trusting their shape. */
export function parseGoogleErrorBody(payload: unknown): GoogleErrorBody {
  if (typeof payload !== 'object' || payload === null) return { error: null, description: null };
  const body = payload as Record<string, unknown>;
  // Google's token endpoint returns {error, error_description}; the People and
  // Calendar APIs wrap it as {error: {code, message, status}}.
  if (typeof body.error === 'string') {
    return {
      error: body.error,
      description: typeof body.error_description === 'string' ? body.error_description : null,
    };
  }
  if (typeof body.error === 'object' && body.error !== null) {
    const inner = body.error as Record<string, unknown>;
    return {
      error: typeof inner.status === 'string' ? inner.status : typeof inner.message === 'string' ? inner.message : null,
      description: typeof inner.message === 'string' ? inner.message : null,
    };
  }
  return { error: null, description: null };
}

/**
 * Classifies an HTTP failure. Order matters: `invalid_grant` is checked before
 * the status, because Google reports a revoked grant as 400 *or* 401 depending
 * on the endpoint, and the distinction is the whole reason the UI can say
 * "revoked" instead of "error".
 */
export function classifyGoogleHttpError(status: number, payload: unknown): GoogleApiErrorCode {
  const { error } = parseGoogleErrorBody(payload);
  if (error === 'invalid_grant') return 'invalid_grant';
  if (error === 'invalid_request' || error === 'invalid_client' || error === 'unauthorized_client') {
    return 'invalid_request';
  }
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'invalid_request';
  return 'malformed_response';
}

/** True when this failure means the stored consent is dead and must be marked. */
export function isConsentRevoked(code: GoogleApiErrorCode): boolean {
  return code === 'invalid_grant';
}

// ---------------------------------------------------------------------------
// Grant state (derived, never stored)
// ---------------------------------------------------------------------------

export type GoogleGrantState = 'not_connected' | 'connected' | 'expired' | 'revoked';

/**
 * The facts a state is derived from — deliberately a plain shape so the unit
 * suite can exercise every branch without a database.
 */
export interface GoogleGrantFacts {
  scopes: readonly string[];
  expiresAt: Date | null;
  refreshFailedAt: Date | null;
  revokedAt: Date | null;
  hasRefreshToken: boolean;
}

/**
 * One honest word per grant.
 *
 *   - no grant                        → not_connected
 *   - consent withdrawn / gone        → revoked   (reconnect is the only fix)
 *   - we tried to renew and failed    → expired
 *   - token expired with no renewer   → expired
 *   - a scope we need was never given → expired   (a usable-looking token that
 *     cannot do the job is worse than an honest "reconnect")
 *   - otherwise                       → connected
 */
export function googleGrantState(
  grant: GoogleGrantFacts | null,
  requiredScopes: readonly string[],
  now: Date = new Date(),
): GoogleGrantState {
  if (grant === null) return 'not_connected';
  if (grant.revokedAt !== null) return 'revoked';
  if (grant.refreshFailedAt !== null) return 'expired';
  if (!scopesCover(grant.scopes, requiredScopes)) return 'expired';
  if (grant.expiresAt !== null && grant.expiresAt.getTime() <= now.getTime() && !grant.hasRefreshToken) {
    return 'expired';
  }
  return 'connected';
}

/** True when every required scope is present in the granted set. */
export function scopesCover(granted: readonly string[], required: readonly string[]): boolean {
  return required.every((scope) => granted.includes(scope));
}

/**
 * True when the access token is past its expiry (or has none) and should be
 * refreshed before use. A missing refresh token is NOT this function's problem:
 * `googleGrantState` already reports that grant as expired.
 */
export function needsRefresh(grant: Pick<GoogleGrantFacts, 'expiresAt' | 'hasRefreshToken'>, now: Date = new Date()): boolean {
  if (!grant.hasRefreshToken) return false;
  if (grant.expiresAt === null) return true;
  return grant.expiresAt.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// People API → contact candidates
// ---------------------------------------------------------------------------

/**
 * One connection read from Google, in the SAME shape the .vcf/.csv import
 * produces (src/domain/contact-import.ts): an email plus a display name, both
 * in memory. It is never a row, never a file and never a log line.
 */
export interface GoogleContactCandidate {
  /** Normalized by `normalizeContactEmail` — identical to the address-book path. */
  email: string;
  name: string | null;
}

export interface ParsedGoogleContacts {
  contacts: GoogleContactCandidate[];
  /** Connections with no usable address (Google allows them: a name and a phone). */
  skipped: number;
  /** Google said there are more pages we did not read. */
  truncated: boolean;
}

/** Hard ceiling mirroring the address-book import's 5000. */
export const GOOGLE_CONTACTS_MAX = 5000;

/**
 * Extracts `{email, name}` pairs from a `people/me/connections` page.
 *
 * Only `names` and `emailAddresses` are read; every other field Google may
 * return is ignored here (and `personFields` asks for nothing else). A person
 * with two addresses contributes two candidates — the same rule the vCard
 * parser uses, because "who is already here" should still answer yes.
 *
 * The candidates are NORMALIZED with the same function the address-book import
 * uses, which is what makes the lookup hash comparable across both paths.
 */
export function parsePeopleConnections(
  payload: unknown,
  opts: { maxContacts?: number } = {},
): ParsedGoogleContacts {
  const maxContacts = opts.maxContacts ?? GOOGLE_CONTACTS_MAX;
  const contacts: GoogleContactCandidate[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  if (typeof payload !== 'object' || payload === null) {
    return { contacts, skipped, truncated: false };
  }
  const body = payload as Record<string, unknown>;
  const rawConnections = Array.isArray(body.connections) ? body.connections : [];

  for (const raw of rawConnections) {
    if (typeof raw !== 'object' || raw === null) {
      skipped++;
      continue;
    }
    const person = raw as Record<string, unknown>;
    const name = personName(person);
    const emails = Array.isArray(person.emailAddresses) ? person.emailAddresses : [];
    let usable = 0;
    for (const rawEmail of emails) {
      if (typeof rawEmail !== 'object' || rawEmail === null) continue;
      const value = (rawEmail as Record<string, unknown>).value;
      if (typeof value !== 'string') continue;
      const email = normalizeContactEmail(value);
      if (email === null) continue;
      usable++;
      if (seen.has(email)) continue;
      if (contacts.length >= maxContacts) break;
      seen.add(email);
      contacts.push({ email, name });
    }
    if (usable === 0) skipped++;
  }

  const truncated = typeof body.nextPageToken === 'string' && body.nextPageToken.length > 0;
  return { contacts, skipped, truncated };
}

/** `names[0].displayName`, trimmed; null when Google gave nothing usable. */
function personName(person: Record<string, unknown>): string | null {
  const names = person.names;
  if (!Array.isArray(names)) return null;
  for (const entry of names) {
    if (typeof entry !== 'object' || entry === null) continue;
    const displayName = (entry as Record<string, unknown>).displayName;
    if (typeof displayName === 'string' && displayName.trim().length > 0) return displayName.trim();
  }
  return null;
}

/** Page size for the connections read — one page is 1000 people, the API max. */
export const GOOGLE_CONTACTS_PAGE_SIZE = 1000;

/** The `personFields` mask: names and addresses, nothing else. */
export const GOOGLE_PERSON_FIELDS = 'names,emailAddresses';

// ---------------------------------------------------------------------------
// Calendar event
// ---------------------------------------------------------------------------

/**
 * Who may appear as an ATTENDEE — the one place the counterpart-email rule can
 * be expressed, and the reason it is a function instead of an `if` inside a
 * route.
 *
 * Returns `[]` unless the user explicitly opted in for THIS action AND an
 * address was supplied. With the default `optIn: false` the counterpart is
 * present in the event only as their display name, in the title/description we
 * build — no address is ever handed to Google.
 */
export function googleCalendarAttendees(
  counterpartEmail: string | null,
  optIn: boolean,
): string[] {
  if (!optIn) return [];
  if (typeof counterpartEmail !== 'string') return [];
  const email = counterpartEmail.trim().toLowerCase();
  if (email.length === 0) return [];
  return [email];
}

export interface BuildCalendarEventInput {
  summary: string;
  description: string | null;
  timezone: string;
  startsAt: Date;
  endsAt: Date | null;
  /** Already passed through `googleCalendarAttendees` by the caller. */
  attendees: readonly string[];
  /** Public card of the counterpart, when there is one. Never an address. */
  sourceUrl?: string | null;
}

/**
 * The `events.insert` body for the user's OWN calendar (`calendars/primary`).
 *
 * `timeZone` plus an offset-carrying `dateTime` keeps the meeting at the wall
 * clock the two people agreed on, which is the same guarantee the .ics export
 * makes; the timezone string arrives validated from `isValidTimezone`
 * (src/domain/events.ts), so the compact same-day schedule elsewhere in the app
 * and this event cannot disagree.
 *
 * `attendees` is emitted ONLY when non-empty: an empty array would tell Google
 * "no guests", which is the same thing as omitting it, and omitting it keeps
 * the request's intent readable.
 */
export function buildCalendarEventBody(input: BuildCalendarEventInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: input.summary,
    start: { dateTime: input.startsAt.toISOString(), timeZone: input.timezone },
  };
  if (input.endsAt) {
    body.end = { dateTime: input.endsAt.toISOString(), timeZone: input.timezone };
  } else {
    // No end given: a zero-length event is honest ("we know when it starts"),
    // whereas an invented duration would be a lie in someone's calendar.
    body.end = { dateTime: input.startsAt.toISOString(), timeZone: input.timezone };
  }
  const description = [input.description, input.sourceUrl]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join('\n\n');
  if (description.length > 0) body.description = description;
  if (input.attendees.length > 0) {
    body.attendees = input.attendees.map((email) => ({ email }));
  }
  return body;
}

/** The subset of a created event we are willing to carry back to the client. */
export interface CreatedCalendarEvent {
  id: string;
  /** Google's own link to the event, when it returned one. */
  htmlLink: string | null;
}

export function parseCreatedCalendarEvent(payload: unknown): CreatedCalendarEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (typeof body.id !== 'string' || body.id.length === 0) return null;
  return {
    id: body.id,
    htmlLink: typeof body.htmlLink === 'string' && body.htmlLink.length > 0 ? body.htmlLink : null,
  };
}

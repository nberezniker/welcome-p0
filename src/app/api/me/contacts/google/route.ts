import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { internalError, jsonError, jsonOk, privateCacheHeaders, withApi } from '../../../../../lib/http';
import { appBaseUrl, requireHashPepper } from '../../../../../lib/env';
import { consumeSubjectToken } from '../../../../../lib/ratelimit';
import { GoogleApiError, listPeopleConnectionsPage } from '../../../../../lib/google-api';
import { loadGoogleAccessToken } from '../../../../../lib/oauth-grants';
import { matchContactEmails, recordContactMatchAudit } from '../../../../../domain/contact-match';
import {
  GOOGLE_CONTACTS_MAX,
  GOOGLE_CONTACTS_PAGE_SIZE,
  GOOGLE_SCOPES,
  googleRedirectUri,
  parsePeopleConnections,
  type GoogleContactCandidate,
} from '../../../../../domain/google-oauth';
import { CONTACTS_IMPORT_PER_HOUR } from '../import/route';

export const dynamic = 'force-dynamic';

/**
 * POST /api/me/contacts/google — "who of my Google contacts is already here".
 *
 * The OAuth sibling of POST /api/me/contacts/import, and it answers the SAME
 * question with the SAME privacy model — literally the same code path
 * (src/domain/contact-match.ts):
 *
 *   - the contact list is read from `people/me/connections` with
 *     `personFields=names,emailAddresses` and NOTHING else;
 *   - it is parsed in memory, normalized with the same `normalizeContactEmail`,
 *     matched by the same peppered HMAC lookup key, and forgotten. No row, no
 *     hash, no job, no file: the only DB write is ONE append-only audit row
 *     holding numbers and the word 'google-contacts';
 *   - the response carries display names, slugs and headlines of matches and
 *     NEVER an email address — not the user's own contacts, and obviously not a
 *     third party's. The caller already has their address book;
 *   - the third party's own data never becomes a WELCOME record. There is no
 *     table for it to land in (migration 013 adds none), which is why the
 *     integration test can prove the absence by scanning the whole schema.
 *
 * WHY IT READS THE USER'S OWN CONTACTS AT ALL: the match must happen somewhere,
 * and the only place it can happen without keeping the address book is in the
 * request that the user just triggered. Nothing is read from Google until this
 * call — the connect step stores a grant and stops there.
 *
 * Statuses (all honest, none a 500):
 *   401 unauthorized            — no session
 *   409 not_connected           — no grant for google-contacts
 *   409 reconnect_required      — grant revoked / expired / expired-by-refresh
 *   403 scope_missing           — Google says the scope is not granted
 *   429 rate_limited            — per-account budget (shared with the .vcf/.csv import)
 *   503 google_unavailable      — Google or the network is down; retry later
 *   200 { scanned, matched_count, matched[], unmatched_count, skipped, truncated }
 */

/** Pages read in one request. 5 pages × 1000 = the same 5000 ceiling as the
 * address-book import, and the loop stops at the first page that has no
 * `nextPageToken`, so a small address book costs one call. */
const MAX_PAGES = Math.ceil(GOOGLE_CONTACTS_MAX / GOOGLE_CONTACTS_PAGE_SIZE);

const WINDOW_MS = 60 * 60 * 1000;

/** Maps a typed Google/grant failure to an honest HTTP answer. */
function failureResponse(reason: string) {
  const headers = privateCacheHeaders();
  switch (reason) {
    case 'not_connected':
      return jsonError(409, 'not_connected', 'Google Contacts is not connected', { headers });
    case 'revoked':
    case 'expired':
    case 'refresh_failed':
      return jsonError(409, 'reconnect_required', 'The Google connection must be renewed', { headers });
    default:
      return jsonError(409, 'not_connected', 'Google Contacts is not connected', { headers });
  }
}

function googleFailureResponse(err: GoogleApiError) {
  const headers = privateCacheHeaders();
  switch (err.code) {
    case 'invalid_grant':
    case 'unauthorized':
      return jsonError(409, 'reconnect_required', 'The Google connection must be renewed', { headers });
    case 'forbidden':
      // The most common real cause: the project or the account lacks the scope.
      return jsonError(403, 'scope_missing', 'Google refused the contacts scope', { headers });
    case 'rate_limited':
      return jsonError(429, 'rate_limited', 'Google is rate limiting this connection', {
        retryable: true,
        headers: { ...headers, 'Retry-After': '60' },
      });
    default:
      return jsonError(503, 'google_unavailable', 'Google is unavailable right now', {
        retryable: true,
        headers,
      });
  }
}

async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    // Same budget as the address-book import, same key: "who is already here" is
    // one user action, and letting each door have its own 5/hour would double it.
    const verdict = consumeSubjectToken(auth.accountId, 'contacts_import', {
      capacity: CONTACTS_IMPORT_PER_HOUR,
      windowMs: WINDOW_MS,
    });
    const rateHeaders = {
      ...privateCacheHeaders(),
      'X-RateLimit-Limit': String(CONTACTS_IMPORT_PER_HOUR),
      'X-RateLimit-Remaining': String(verdict.remaining),
      'X-RateLimit-Reset': String(Math.ceil((verdict.nowMs + verdict.retryAfterMs) / 1000)),
    };
    if (!verdict.allowed) {
      return jsonError(429, 'rate_limited', 'Too many import requests. Try again later.', {
        retryable: true,
        headers: {
          ...rateHeaders,
          'Retry-After': String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))),
        },
      });
    }

    const sql = getSql();
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? '';
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '';

    const token = await loadGoogleAccessToken(sql, {
      accountId: auth.accountId,
      provider: 'google-contacts',
      clientId,
      clientSecret,
      redirectUri: googleRedirectUri(appBaseUrl()),
    });
    if (!token.ok) return failureResponse(token.reason);

    // Read the address book in memory, page by page. Nothing is written, nothing
    // is buffered to disk, and only the candidates survive this loop.
    const contacts: GoogleContactCandidate[] = [];
    let skipped = 0;
    let pageToken: string | null = null;
    let readEveryPage = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await listPeopleConnectionsPage(token.accessToken, { pageToken });
      const parsed = parsePeopleConnections(result.payload, { maxContacts: GOOGLE_CONTACTS_MAX - contacts.length });
      contacts.push(...parsed.contacts);
      skipped += parsed.skipped;
      pageToken = result.nextPageToken;
      if (pageToken === null) {
        readEveryPage = true;
        break;
      }
      // Either ceiling stops the loop; both mean there is more we did not read.
      if (contacts.length >= GOOGLE_CONTACTS_MAX) break;
    }

    const match = await matchContactEmails(sql, {
      accountId: auth.accountId,
      emails: contacts.map((contact) => contact.email),
      pepper: requireHashPepper(),
    });

    // The only write: which door the address book came through, and how many.
    await recordContactMatchAudit(sql, auth.accountId, 'google-contacts', {
      scanned: match.scanned,
      matched_count: match.matched_count,
      skipped,
    });

    return jsonOk(
      {
        ok: true,
        scanned: match.scanned,
        matched_count: match.matched_count,
        matched: match.matched,
        unmatched_count: match.unmatched_count,
        matched_truncated: match.matched_truncated,
        skipped,
        // Honest about the ceiling: more contacts exist at Google than we read,
        // whichever limit stopped us (the 5000-contact cap or the page budget).
        truncated: !readEveryPage,
        scopes: [...GOOGLE_SCOPES['google-contacts']],
      },
      { headers: rateHeaders },
    );
  } catch (err) {
    if (err instanceof GoogleApiError) return googleFailureResponse(err);
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

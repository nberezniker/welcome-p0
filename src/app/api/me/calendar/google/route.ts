import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { internalError, jsonError, jsonOk, privateCacheHeaders, readJsonBody, withApi } from '../../../../../lib/http';
import { appBaseUrl } from '../../../../../lib/env';
import { formatEventWhen } from '../../../../../lib/event-time';
import { googleRedirectUri } from '../../../../../domain/google-oauth';
import { GoogleApiError, createCalendarEvent } from '../../../../../lib/google-api';
import { loadGoogleAccessToken } from '../../../../../lib/oauth-grants';
import { recordAudit } from '../../../../../lib/audit';
import { isValidTimezone } from '../../../../../domain/events';
import {
  buildCalendarEventBody,
  googleCalendarAttendees,
} from '../../../../../domain/google-oauth';
import { getLocale, t as translate } from '../../../../../i18n';

export const dynamic = 'force-dynamic';

/**
 * POST /api/me/calendar/google — put the agreed meeting in the user's OWN
 * Google Calendar.
 *
 * Body:
 *   { counterpart_slug: string, starts_at: ISO, ends_at?: ISO, timezone: IANA,
 *     title?: string, include_counterpart_email?: boolean, counterpart_email?: string }
 *
 * THE PRIVACY RULE, AND WHERE IT IS ENFORCED (design §C, project brief):
 * the counterpart's address is sent to Google ONLY when the user explicitly opts
 * in ON THIS ACTION. The default body contains no address at all — the
 * counterpart appears as their display name in the event, and that is it.
 *
 * Two things make that structural rather than a promise:
 *   1. `googleCalendarAttendees(counterpartEmail, optIn)` is the only producer of
 *      an attendee list (src/domain/google-oauth.ts), and it returns `[]` for the
 *      default `optIn: false`;
 *   2. supplying `counterpart_email` WITHOUT `include_counterpart_email: true` is
 *      a 400, not a silent drop — a field the user filled in that we quietly
 *      discard is worse than a refusal, because they would believe it was used.
 *
 * The user's own address book is never involved: nothing here reads a contact
 * list, and no email is stored anywhere (there is no column for it).
 *
 * Reused helpers rather than new ones: `isValidTimezone` (src/domain/events.ts)
 * validates the zone exactly as event creation does, and `formatEventWhen`
 * (src/lib/event-time.ts) produces the compact same-day schedule the rest of the
 * app shows, so a meeting created here and the same meeting on an event page
 * read the same way.
 *
 * Statuses: 401 · 400 invalid_body / invalid_timezone / invalid_start /
 *           400 invalid_end / 400 counterpart_email_requires_opt_in ·
 *           404 counterpart_not_found · 409 not_connected / reconnect_required ·
 *           403 scope_missing · 429 rate_limited · 503 google_unavailable ·
 *           201 created (never a 500 for a Google failure).
 */

const TITLE_MAX = 200;
/** The counterpart's address, if it is ever accepted, is a plain address. */
const EMAIL_MAX = 320;

interface CounterpartRow {
  display_name: string;
  public_slug: string;
}

/** Reads only what the event text needs. No contact values, nothing decrypted. */
async function loadCounterpart(slug: string): Promise<CounterpartRow | null> {
  const sql = getSql();
  const rows = await sql<CounterpartRow[]>`
    SELECT p.display_name, p.public_slug
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.public_slug = ${slug} AND a.status = 'active'
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function grantFailureResponse(reason: string) {
  const headers = privateCacheHeaders();
  if (reason === 'not_connected') {
    return jsonError(409, 'not_connected', 'Google Calendar is not connected', { headers });
  }
  return jsonError(409, 'reconnect_required', 'The Google connection must be renewed', { headers });
}

function googleFailureResponse(err: GoogleApiError) {
  const headers = privateCacheHeaders();
  switch (err.code) {
    case 'invalid_grant':
    case 'unauthorized':
      return jsonError(409, 'reconnect_required', 'The Google connection must be renewed', { headers });
    case 'forbidden':
      return jsonError(403, 'scope_missing', 'Google refused the calendar scope', { headers });
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

    const body = await readJsonBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return jsonError(400, 'invalid_body', 'JSON object expected', { headers: privateCacheHeaders() });
    }
    const fields = body as Record<string, unknown>;

    const slug = typeof fields.counterpart_slug === 'string' ? fields.counterpart_slug.trim() : '';
    if (slug.length < 1 || slug.length > 128) {
      return jsonError(400, 'invalid_body', 'counterpart_slug is required', { headers: privateCacheHeaders() });
    }

    const startsAt = parseInstant(fields.starts_at);
    if (startsAt === null) {
      return jsonError(400, 'invalid_start', 'starts_at must be an ISO 8601 instant', {
        headers: privateCacheHeaders(),
      });
    }
    const endsAt = fields.ends_at === undefined || fields.ends_at === null ? null : parseInstant(fields.ends_at);
    if (fields.ends_at !== undefined && fields.ends_at !== null && endsAt === null) {
      return jsonError(400, 'invalid_end', 'ends_at must be an ISO 8601 instant', {
        headers: privateCacheHeaders(),
      });
    }
    if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
      return jsonError(400, 'invalid_end', 'ends_at must be after starts_at', {
        headers: privateCacheHeaders(),
      });
    }

    const timezone = typeof fields.timezone === 'string' ? fields.timezone.trim() : '';
    if (!isValidTimezone(timezone)) {
      return jsonError(400, 'invalid_timezone', 'timezone must be a valid IANA zone (e.g. Europe/Madrid)', {
        headers: privateCacheHeaders(),
      });
    }

    const title = typeof fields.title === 'string' ? fields.title.trim() : '';
    if (title.length > TITLE_MAX) {
      return jsonError(400, 'invalid_body', `title must be at most ${TITLE_MAX} characters`, {
        headers: privateCacheHeaders(),
      });
    }

    // --- the counterpart's address: opt-in, per action, or not at all ---------
    const optIn = fields.include_counterpart_email === true;
    const rawEmail = typeof fields.counterpart_email === 'string' ? fields.counterpart_email.trim() : '';
    if (rawEmail.length > EMAIL_MAX) {
      return jsonError(400, 'invalid_body', 'counterpart_email is too long', { headers: privateCacheHeaders() });
    }
    if (rawEmail.length > 0 && !optIn) {
      // Refused, not dropped: the flag is the consent, and a filled-in field that
      // we silently ignore would make the user believe Google got the address.
      return jsonError(
        400,
        'counterpart_email_requires_opt_in',
        'Counterpart email is only sent when include_counterpart_email is true',
        { headers: privateCacheHeaders() },
      );
    }
    const attendees = googleCalendarAttendees(rawEmail.length > 0 ? rawEmail : null, optIn);

    const counterpart = await loadCounterpart(slug);
    if (!counterpart) {
      return jsonError(404, 'counterpart_not_found', 'No such public card', {
        headers: privateCacheHeaders(),
      });
    }

    const sql = getSql();
    const token = await loadGoogleAccessToken(sql, {
      accountId: auth.accountId,
      provider: 'google-calendar',
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      redirectUri: googleRedirectUri(appBaseUrl()),
    });
    if (!token.ok) return grantFailureResponse(token.reason);

    // Locale-aware text for the USER's own calendar, from the app's dictionaries.
    const locale = await getLocale();
    const when = formatEventWhen(startsAt, endsAt, timezone, locale);
    const cardUrl = `${appBaseUrl().replace(/\/+$/, '')}/p/${counterpart.public_slug}`;
    const eventBody = buildCalendarEventBody({
      summary: title.length > 0 ? title : translate(locale, 'calendar.event.summary', { name: counterpart.display_name }),
      // Compact same-day schedule first (the format the rest of the app uses),
      // then the card, then the provenance line. Never an address.
      description: [when, translate(locale, 'calendar.event.origin')].filter((part): part is string => part !== null).join('\n\n'),
      timezone,
      startsAt,
      endsAt,
      attendees,
      sourceUrl: cardUrl,
    });

    const created = await createCalendarEvent(token.accessToken, eventBody);

    // Audit: the shape of the action, not its content. `attendees_sent` is the
    // number that makes the privacy rule auditable after the fact.
    await recordAudit(sql, auth.accountId, 'calendar.google.create', 'account', auth.accountId, {
      provider: 'google-calendar',
      counterpart_profile_slug: counterpart.public_slug,
      attendees_sent: attendees.length,
      timezone,
    });

    return jsonOk(
      {
        ok: true,
        event: { id: created.id, html_link: created.htmlLink },
        counterpart: { display_name: counterpart.display_name, slug: counterpart.public_slug },
        // 0 or 1 — and the UI says which, so "we did not send their address" is
        // visible in the product, not just in this comment.
        attendees_sent: attendees.length,
        timezone,
      },
      { status: 201, headers: privateCacheHeaders() },
    );
  } catch (err) {
    if (err instanceof GoogleApiError) return googleFailureResponse(err);
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

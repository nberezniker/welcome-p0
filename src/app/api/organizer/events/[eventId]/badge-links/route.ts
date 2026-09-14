import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { internalError, jsonError, jsonOk, withApi } from '../../../../../../lib/http';
import { requireEventRole } from '../../../../../../domain/organizer';
import { challengeTtlMinutes } from '../../../../../../domain/challenges';
import { generateSessionToken, hashSessionToken } from '../../../../../../lib/crypto';
import { checkRateLimit } from '../../../../../../lib/ratelimit';
import { recordAudit } from '../../../../../../lib/audit';
import { appBaseUrl } from '../../../../../../lib/env';
import { neutralizeCsvCell } from '../../../../../../domain/csv';
import { qrSvgDataUrl } from '../../../../../../lib/qr';

export const dynamic = 'force-dynamic';

/**
 * POST /api/organizer/events/[eventId]/badge-links — issue claim links for the
 * event's unclaimed registrations, so their badges can carry a QR the guest can
 * actually act on.
 *
 * This is a POST on purpose: claim tokens are stored only as SHA-256 hashes, so
 * the plaintext exists exactly once — at issuance. A GET that minted tokens
 * would both write on a read and hand out links nobody asked for.
 *
 * The CSV carries `registration_id,claim_url` and nothing else: the ids are
 * opaque and the URLs are one-time, so the file can be mailed around without
 * leaking an email or a phone number.
 */

const BADGE_LINK_RATE_WINDOW_MINUTES = 60;
const BADGE_LINK_RATE_MAX = 200;

interface UnclaimedRow {
  id: string;
  imported_name: string | null;
}

async function postRoute(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { eventId } = await params;
    const sql = getSql();
    const role = await requireEventRole(sql, auth.accountId, eventId, ['owner', 'admin']);
    if (!role) return jsonError(403, 'forbidden', 'You do not manage this event');

    const eventRows = await sql<{ slug: string }[]>`SELECT slug FROM events WHERE id = ${eventId} LIMIT 1`;
    const event = eventRows[0];
    if (!event) return jsonError(404, 'not_found', 'Event not found');

    const limit = await checkRateLimit(sql, {
      table: 'audit_events',
      subjectColumn: 'actor_account_id',
      subjectId: auth.accountId,
      windowMinutes: BADGE_LINK_RATE_WINDOW_MINUTES,
      max: BADGE_LINK_RATE_MAX,
    });
    if (limit.limited) {
      return jsonError(429, 'rate_limited', 'Too many claim-link batches. Try again later.', {
        retryable: true,
        headers: { 'Retry-After': String(limit.retryAfterSeconds) },
      });
    }

    // Only rows that CAN be claimed: unclaimed and not quarantined. Already
    // claimed guests have a card, so their badge points at the card instead.
    const rows = await sql<UnclaimedRow[]>`
      SELECT id, imported_name
      FROM registrations
      WHERE event_id = ${eventId}::uuid
        AND claim_state = 'unclaimed'
        AND approval_status <> 'quarantined'
      ORDER BY imported_name ASC NULLS LAST, id ASC
    `;

    const ttlMinutes = challengeTtlMinutes('registration_claim');
    const base = appBaseUrl();
    const links: { registration_id: string; name: string | null; claim_url: string; qr_data_url: string }[] = [];

    for (const row of rows) {
      const token = generateSessionToken();
      await sql`
        INSERT INTO link_challenges (account_id, purpose, token_hash, expires_at, registration_id)
        VALUES (NULL, 'registration_claim', ${hashSessionToken(token)},
                now() + (${ttlMinutes} * interval '1 minute'), ${row.id}::uuid)
      `;
      const claimUrl = `${base}/claim/${token}`;
      // Server-side QR as an inline data URL: the printable sheet needs no
      // client QR library and no external asset.
      const qrDataUrl = await qrSvgDataUrl(claimUrl);
      links.push({ registration_id: row.id, name: row.imported_name, claim_url: claimUrl, qr_data_url: qrDataUrl });
    }

    await recordAudit(sql, auth.accountId, 'badges.claim_links_issued', 'event', eventId, {
      issued: links.length,
    });

    // Registration id + URL only — no names, emails or phones.
    const csvLines = ['registration_id,claim_url'];
    for (const link of links) {
      const url = neutralizeCsvCell(link.claim_url);
      csvLines.push(`${link.registration_id},${/[",\r\n]/.test(url) ? `"${url.replace(/"/g, '""')}"` : url}`);
    }

    return jsonOk({
      ok: true,
      issued: links.length,
      event_slug: event.slug,
      links,
      csv: csvLines.join('\r\n') + '\r\n',
    });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

import type { Sql } from 'postgres';
import { qrSvgDataUrl } from './qr';

/**
 * Badge-sheet data assembly, kept out of the page component so it can be tested
 * without a React request scope.
 *
 * Privacy is structural, not a filter: the query selects no email column and no
 * contact table, so a badge physically cannot carry an address or a phone
 * number. Quarantined registrations are dropped — printing a badge for someone
 * who is not approved to attend would be a mistake, not a convenience.
 */
export interface BadgeCard {
  registrationId: string;
  name: string;
  /** Where the printed QR points today (card URL, or the event page until a claim link exists). */
  qrUrl: string;
  qrDataUrl: string;
  /** No card yet: the QR can be upgraded to a one-time claim link. */
  needsClaimLink: boolean;
}

export interface BadgeSheetData {
  event: { id: string; slug: string; name: string };
  cards: BadgeCard[];
  /** Registrations left off the sheet because they are quarantined. */
  quarantined: number;
}

interface BadgeRow {
  registration_id: string;
  imported_name: string | null;
  approval_status: string;
  display_name: string | null;
  public_slug: string | null;
}

export async function loadBadgeSheet(
  sql: Sql,
  eventId: string,
  baseUrl: string,
  fallbackName: string,
): Promise<BadgeSheetData | null> {
  const [eventRows, rows] = await Promise.all([
    sql<{ id: string; slug: string; name: string }[]>`
      SELECT id, slug, name FROM events WHERE id = ${eventId}::uuid LIMIT 1
    `,
    sql<BadgeRow[]>`
      SELECT r.id AS registration_id, r.imported_name, r.approval_status,
             pr.display_name, pr.public_slug
      FROM registrations r
      LEFT JOIN event_memberships m ON m.registration_id = r.id
      LEFT JOIN profiles pr ON pr.id = m.profile_id
      WHERE r.event_id = ${eventId}::uuid
      ORDER BY COALESCE(pr.display_name, r.imported_name, '') ASC, r.id ASC
    `,
  ]);

  const event = eventRows[0];
  if (!event) return null;

  const eventUrl = `${baseUrl}/e/${encodeURIComponent(event.slug)}`;
  const quarantined = rows.filter((r) => r.approval_status === 'quarantined').length;

  const cards = await Promise.all(
    rows
      .filter((r) => r.approval_status !== 'quarantined')
      .map(async (row) => {
        // A guest with a card gets a QR straight to it (the slug never changes,
        // so the badge never needs reprinting). Everyone else gets the event
        // page until the organizer issues a claim link for them.
        const qrUrl = row.public_slug ? `${baseUrl}/p/${encodeURIComponent(row.public_slug)}` : eventUrl;
        return {
          registrationId: row.registration_id,
          name: row.display_name ?? row.imported_name ?? fallbackName,
          qrUrl,
          qrDataUrl: await qrSvgDataUrl(qrUrl),
          needsClaimLink: row.public_slug === null,
        };
      }),
  );

  return { event, cards, quarantined };
}

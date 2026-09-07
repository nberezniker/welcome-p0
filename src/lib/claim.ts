import type { Sql } from 'postgres';
import { hashSessionToken } from './crypto';

/** Claim-link preview for the GET /claim/[token] page.
 * Strictly read-only: a GET must NEVER consume the challenge (AC-07). */

export interface ClaimPreview {
  event: { name: string };
  organizerName: string | null;
  alreadyClaimed: boolean;
  expired: boolean;
}

export async function loadClaimPreview(sql: Sql, rawToken: string): Promise<ClaimPreview | null> {
  const tokenHash = hashSessionToken(rawToken);
  const rows = await sql<{
    event_name: string;
    organizer_name: string | null;
    consumed_at: Date | null;
    expires_at: Date;
    claim_state: string;
  }[]>`
    SELECT e.name AS event_name, o.display_name AS organizer_name,
           c.consumed_at, c.expires_at, r.claim_state
    FROM link_challenges c
    JOIN registrations r ON r.id = c.registration_id
    JOIN events e ON e.id = r.event_id
    JOIN organizers o ON o.id = e.organizer_id
    WHERE c.token_hash = ${tokenHash} AND c.purpose = 'registration_claim'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  return {
    event: { name: row.event_name },
    organizerName: row.organizer_name,
    alreadyClaimed: row.consumed_at !== null || row.claim_state === 'claimed',
    expired: new Date(row.expires_at).getTime() <= Date.now(),
  };
}

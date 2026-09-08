import type { Sql } from 'postgres';
import { isUuid } from '../domain/organizer';

/** Event projection shared by the API route and the /e/[slug] page.
 * online_link is resolved ONLY for an active member — never for anonymous
 * viewers, other participants, or organizers via this view. */

export interface EventView {
  event: {
    id: string;
    slug: string;
    name: string;
    mode: string | null;
    access_mode: string | null;
    status: string;
    starts_at: Date | null;
    ends_at: Date | null;
    timezone: string;
    location_label: string | null;
    description: string | null;
    consent_text: string | null;
  };
  viewer: {
    is_member: boolean;
    online_link: string | null;
  };
}

export async function loadEventView(
  sql: Sql,
  idOrSlug: string,
  accountId: string | null,
): Promise<EventView | null> {
  const byId = isUuid(idOrSlug);
  const rows = await sql<
    {
      id: string; slug: string; name: string; mode: string | null; access_mode: string | null;
      status: string; starts_at: Date | null; ends_at: Date | null; timezone: string;
      location_label: string | null; online_link: string | null; description: string | null; consent_text: string | null;
    }[]
  >`
    SELECT id, slug, name, mode, access_mode, status, starts_at, ends_at, timezone,
           location_label, online_link, description, consent_text
    FROM events
    WHERE ${byId ? sql`id = ${idOrSlug}::uuid` : sql`slug = ${idOrSlug}`}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  let isMember = false;
  if (accountId) {
    const memberRows = await sql<{ id: string }[]>`
      SELECT m.id
      FROM event_memberships m
      JOIN profiles p ON p.id = m.profile_id
      WHERE m.event_id = ${row.id} AND p.account_id = ${accountId} AND m.state = 'active'
      LIMIT 1
    `;
    isMember = Boolean(memberRows[0]);
  }

  return {
    event: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      mode: row.mode,
      access_mode: row.access_mode,
      status: row.status,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      timezone: row.timezone,
      location_label: row.location_label,
      description: row.description,
      consent_text: row.consent_text,
    },
    viewer: {
      is_member: isMember,
      online_link: isMember ? row.online_link : null,
    },
  };
}

/** This endpoint is member-conditional: never cache across viewers. */
export function eventViewCacheHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store, private',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

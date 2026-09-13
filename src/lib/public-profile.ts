import { getSql } from './db';
import { decryptValue } from './crypto';
import { requireEncryptionKey } from './env';
import type { ContactKind } from '../domain/profile';

/**
 * Public projection of a profile. ONLY these fields may ever leave the server
 * via public endpoints — no email, account ids, revision, or disabled contacts.
 *
 * Card opt-outs (migration 008): a field id listed in `profiles.hidden_fields`
 * is withheld here, so a hidden field never reaches the API JSON, the server
 * rendered page, or the vCard — the projection is the single choke point.
 */
export interface PublicContact {
  kind: ContactKind;
  value: string;
}

export interface PublicProfile {
  slug: string;
  display_name: string;
  headline: string | null;
  company: string | null;
  short_bio: string | null;
  languages: string[];
  offer_tags: string[];
  need_tags: string[];
  need_intents: string[];
  offer_intents: string[];
  interests: string[];
  keywords: string[];
  contacts: PublicContact[];
}

/** Loads the public projection for a slug, or null when missing/inactive. */
export async function loadPublicProfile(slug: string): Promise<PublicProfile | null> {
  const sql = getSql();
  const rows = await sql<{
    profile_id: string;
    public_slug: string;
    display_name: string;
    headline: string | null;
    company: string | null;
    short_bio: string | null;
    languages: string[];
    offer_tags: string[];
    need_tags: string[];
    need_intents: string[];
    offer_intents: string[];
    interests: string[];
    keywords: string[];
    hidden_fields: string[];
  }[]>`
    SELECT p.id AS profile_id, p.public_slug, p.display_name, p.headline, p.company,
           p.short_bio, p.languages, p.offer_tags, p.need_tags,
           p.need_intents, p.offer_intents, p.interests, p.keywords, p.hidden_fields
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id
    WHERE p.public_slug = ${slug} AND a.status = 'active'
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  const contactRows = await sql<{ kind: string; encrypted_value: string }[]>`
    SELECT kind, encrypted_value
    FROM contact_fields
    WHERE profile_id = ${row.profile_id} AND public_enabled = true
    ORDER BY updated_at ASC
  `;

  let contacts: PublicContact[] = [];
  if (contactRows.length > 0) {
    const key = requireEncryptionKey();
    contacts = contactRows.map((c) => ({
      kind: c.kind as ContactKind,
      value: decryptValue(c.encrypted_value, key),
    }));
  }

  // Deny list: anything the user unticked in the card consent step.
  const hidden = new Set(row.hidden_fields);
  const visibleList = (field: string, value: string[]): string[] => (hidden.has(field) ? [] : value);
  const visibleText = (field: string, value: string | null): string | null =>
    hidden.has(field) ? null : value;

  return {
    slug: row.public_slug,
    display_name: row.display_name,
    headline: visibleText('headline', row.headline),
    company: visibleText('company', row.company),
    short_bio: visibleText('short_bio', row.short_bio),
    languages: visibleList('languages', row.languages),
    offer_tags: visibleList('offer_tags', row.offer_tags),
    need_tags: visibleList('need_tags', row.need_tags),
    need_intents: visibleList('need_intents', row.need_intents),
    offer_intents: visibleList('offer_intents', row.offer_intents),
    interests: visibleList('interests', row.interests),
    keywords: visibleList('keywords', row.keywords),
    contacts,
  };
}

/**
 * The event (if any) where the signed-in viewer and the card owner are BOTH
 * active members — the landing page's "propose an introduction" affordance only
 * exists in a shared-event context (personal-context introductions are not
 * reachable from a public card). Returns null for anonymous viewers, for the
 * owner's own card, and when there is no shared event.
 */
export async function findSharedEventId(
  viewerAccountId: string,
  targetProfileId: string,
): Promise<string | null> {
  const sql = getSql();
  const rows = await sql<{ event_id: string }[]>`
    SELECT mine.event_id
    FROM event_memberships mine
    JOIN profiles viewer ON viewer.id = mine.profile_id
    JOIN event_memberships theirs ON theirs.event_id = mine.event_id
    WHERE viewer.account_id = ${viewerAccountId}
      AND mine.state = 'active'
      AND theirs.profile_id = ${targetProfileId}
      AND theirs.state = 'active'
    ORDER BY mine.event_id ASC
    LIMIT 1
  `;
  return rows[0]?.event_id ?? null;
}

/** Minimal response headers for public endpoints. */
export function publicCacheHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'public, max-age=60',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

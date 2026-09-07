import { getSql } from './db';
import { decryptValue } from './crypto';
import { requireEncryptionKey } from './env';
import type { ContactKind } from '../domain/profile';

/**
 * Public projection of a profile. ONLY these fields may ever leave the server
 * via public endpoints — no email, account ids, revision, or disabled contacts.
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
  }[]>`
    SELECT p.id AS profile_id, p.public_slug, p.display_name, p.headline, p.company,
           p.short_bio, p.languages, p.offer_tags, p.need_tags
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

  return {
    slug: row.public_slug,
    display_name: row.display_name,
    headline: row.headline,
    company: row.company,
    short_bio: row.short_bio,
    languages: row.languages,
    offer_tags: row.offer_tags,
    need_tags: row.need_tags,
    contacts,
  };
}

/** Minimal response headers for public endpoints. */
export function publicCacheHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'public, max-age=60',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

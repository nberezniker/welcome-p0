import { getSql } from './db';
import { decryptStored } from './crypto';
import { requireKeyring } from './env';
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
    const keyring = requireKeyring();
    contacts = contactRows.map((c) => ({
      kind: c.kind as ContactKind,
      value: decryptStored(c.encrypted_value, keyring),
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
 * The shared-event context of a card, if any: the event where the signed-in
 * viewer AND the card owner are both active members.
 *
 * Used for ONE thing — deciding whether the card offers "propose an
 * introduction". That flow is event-scoped and mutual-consent, so the card only
 * offers it to a viewer who already shares an event, and the ids it needs
 * (event id + target profile id) are ones that viewer can already see in that
 * event's directory. Anonymous visitors get null and never receive an id.
 */
export async function findSharedEvent(
  slug: string,
  viewerAccountId: string,
): Promise<{ eventId: string; targetProfileId: string } | null> {
  const sql = getSql();
  const rows = await sql<{ event_id: string; profile_id: string }[]>`
    SELECT mine.event_id, theirs.profile_id
    FROM profiles target
    JOIN accounts target_account ON target_account.id = target.account_id AND target_account.status = 'active'
    JOIN event_memberships theirs ON theirs.profile_id = target.id AND theirs.state = 'active'
    JOIN event_memberships mine ON mine.event_id = theirs.event_id AND mine.state = 'active'
    JOIN profiles viewer ON viewer.id = mine.profile_id
    WHERE target.public_slug = ${slug} AND viewer.account_id = ${viewerAccountId}
    ORDER BY mine.event_id ASC
    LIMIT 1
  `;
  const row = rows[0];
  return row ? { eventId: row.event_id, targetProfileId: row.profile_id } : null;
}

/**
 * True when the signed-in viewer's account OWNS the profile behind this slug —
 * i.e. the viewer is looking at their own card.
 *
 * WHY IT IS A SEPARATE LOOKUP AND NOT A FIELD OF `PublicProfile`. The public
 * projection must not carry an account id: it is served to anonymous visitors
 * and crawlers, and "which account owns this card" is exactly the identifier
 * that projection exists to withhold. The ownership question is therefore asked
 * about the VIEWER's own account — a boolean whose only subject is the person
 * asking, which is why answering it leaks nothing about anybody. It is also
 * outside the `hidden_fields` deny list on purpose: the owner may hide their
 * company from the world, but the fact that the card is theirs is not a published
 * field, it is how the page decides what to offer them.
 *
 * WHY AN OWN CARD NEEDS ITS OWN ANSWER. `findSharedEvent` answers "is there an
 * event the two of us are both in" with a self-join in its query, so for the
 * owner's own card it answers YES (the viewer and the target are the same
 * profile) and hands back the viewer's own profile id. The card then offered an
 * introduction to itself, and `POST /api/introductions` answered `400 self_intro`
 * — an affordance that could only fail. The card asks this first now.
 */
export async function viewerOwnsCard(slug: string, viewerAccountId: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    SELECT p.id
    FROM profiles p
    JOIN accounts a ON a.id = p.account_id AND a.status = 'active'
    WHERE p.public_slug = ${slug} AND p.account_id = ${viewerAccountId}
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Minimal response headers for public endpoints. */
export function publicCacheHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'public, max-age=60',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

/**
 * "Who of my contacts is already here" — the ONE matching implementation, shared
 * by the address-book import (POST /api/me/contacts/import) and the Google
 * Contacts import (POST /api/me/contacts/google).
 *
 * Phase 2 extracted this from the address-book route rather than writing a
 * second copy: the privacy contract below is a property of the CODE PATH, not of
 * a document, so a new source of contacts must not be able to get it slightly
 * wrong. Both routes hand over a bag of addresses and get back the same numbers
 * and the same rows.
 *
 * The contract (interop §A1.3/§C, non-negotiable):
 *
 *   - the third party's address book is NEVER persisted — not the addresses that
 *     matched, not the ones that did not, not even a hash of them. Nothing in
 *     this module writes a row;
 *   - matching goes through the peppered HMAC lookup key (`emailLookupHash`) that
 *     the product ALREADY stores for its own users, so the import adds no new
 *     data and cannot be used as an oracle for anyone who is not on WELCOME;
 *   - only matches are returned, and only as `{display_name, slug, headline}` —
 *     never an email address: the caller already owns their address book, we are
 *     telling them who is HERE;
 *   - the caller's single allowed write is one append-only audit row holding
 *     two NUMBERS. `recordContactMatchAudit` exists so that write is the same
 *     shape in both routes too.
 */

import type { Sql } from 'postgres';
import { emailLookupHash } from '../lib/crypto';
import { recordAudit } from '../lib/audit';

/** Rows read from the DB. A bound, not a promise: `matched_truncated` says so. */
export const CONTACT_MATCH_READ_LIMIT = 200;
/** Matches returned to the client. */
export const CONTACT_MATCH_RESPONSE_LIMIT = 50;

/**
 * How many "who is already here" runs one account gets per hour, ACROSS both
 * doors (.vcf/.csv and Google Contacts). It is quoted in the UI copy, and it is
 * a single budget on purpose: the two endpoints answer the same question, and
 * two separate budgets would quietly double what a user can spend.
 */
export const CONTACTS_IMPORT_PER_HOUR = 5;

/** One match, in the only shape that is ever allowed to leave the server. */
export interface ContactMatch {
  display_name: string;
  slug: string;
  headline: string | null;
}

export interface ContactMatchResult {
  /** Addresses that were looked up (deduplicated by the caller's parser). */
  scanned: number;
  matched_count: number;
  matched: ContactMatch[];
  unmatched_count: number;
  /** True when more matches exist than CONTACT_MATCH_RESPONSE_LIMIT. */
  matched_truncated: boolean;
}

/**
 * Looks up a batch of ALREADY NORMALIZED addresses and returns the matches.
 *
 * `hashes` are peppered HMACs, never addresses — the raw address never reaches
 * this function, so it cannot appear in a query, a log or a plan. The account's
 * own row is excluded: "who of my contacts is here" is not a question about me.
 */
export async function matchContactHashes(
  sql: Sql,
  opts: { accountId: string; hashes: readonly string[] },
): Promise<ContactMatchResult> {
  const hashes = [...opts.hashes];
  if (hashes.length === 0) {
    return {
      scanned: 0,
      matched_count: 0,
      matched: [],
      unmatched_count: 0,
      matched_truncated: false,
    };
  }

  const rows = await sql<{ display_name: string; public_slug: string; headline: string | null }[]>`
    SELECT p.display_name, p.public_slug, p.headline
    FROM accounts a
    JOIN profiles p ON p.account_id = a.id
    WHERE a.email_lookup_hash = ANY(${hashes}::text[])
      AND a.status = 'active'
      AND a.id <> ${opts.accountId}
    ORDER BY p.display_name ASC
    LIMIT ${CONTACT_MATCH_READ_LIMIT}
  `;

  const matched = rows.slice(0, CONTACT_MATCH_RESPONSE_LIMIT).map((row) => ({
    display_name: row.display_name,
    slug: row.public_slug,
    headline: row.headline,
  }));

  return {
    scanned: hashes.length,
    matched_count: rows.length,
    matched,
    unmatched_count: Math.max(0, hashes.length - rows.length),
    matched_truncated: rows.length >= CONTACT_MATCH_READ_LIMIT,
  };
}

/** Convenience wrapper: normalize + pepper + match, in that order, once. */
export async function matchContactEmails(
  sql: Sql,
  opts: { accountId: string; emails: readonly string[]; pepper: string },
): Promise<ContactMatchResult> {
  return matchContactHashes(sql, {
    accountId: opts.accountId,
    hashes: opts.emails.map((email) => emailLookupHash(email, opts.pepper)),
  });
}

/**
 * The ONE write either import is allowed to make: what happened, in numbers,
 * without any content.
 *
 * The metadata keys are pinned by tests/integration/contact-import.test.ts
 * (`format, matched_count, scanned, skipped`) and are unchanged by the Phase 2
 * extraction. `format` is which door the address book came through — 'vcard',
 * 'csv', or 'google-contacts' — so an operator can answer "was this the OAuth
 * path" without the payload saying anything about people.
 */
export async function recordContactMatchAudit(
  sql: Sql,
  actorAccountId: string,
  format: string,
  metadata: { scanned: number; matched_count: number; skipped: number },
): Promise<void> {
  await recordAudit(sql, actorAccountId, 'contacts.import.match', 'account', actorAccountId, {
    scanned: metadata.scanned,
    matched_count: metadata.matched_count,
    skipped: metadata.skipped,
    format,
  });
}

import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { internalError, jsonError, jsonOk, privateCacheHeaders, readJsonBody, withApi } from '../../../../../lib/http';
import { requireHashPepper } from '../../../../../lib/env';
import { consumeSubjectToken } from '../../../../../lib/ratelimit';
import {
  CONTACT_IMPORT_MAX_BYTES,
  CONTACT_IMPORT_MAX_CONTACTS,
  parseContacts,
} from '../../../../../domain/contact-import';
import { matchContactEmails, recordContactMatchAudit, CONTACTS_IMPORT_PER_HOUR } from '../../../../../domain/contact-match';

/** POST /api/me/contacts/import — "who of my contacts is already here".
 *
 * Body: JSON { content: string (the address book: .vcf or CSV text), filename? }.
 *
 * Privacy contract (interop §A1.3/§C — the reason this route exists at all):
 *   - the address book is parsed in memory and immediately forgotten: NOTHING
 *     from it is persisted. No contact rows, no hashes, not even a job;
 *   - matching uses the existing peppered lookup key (`emailLookupHash` with
 *     HASH_PEPPER) against `accounts.email_lookup_hash`, which the product
 *     already holds for its own users — the import adds no new data;
 *   - the response carries display names, slugs and headlines of matches and
 *     NEVER an email address (the caller already has their own address book; we
 *     are telling them who is here, not echoing them their own file back);
 *   - the only DB write is one append-only `audit_events` row holding two
 *     numbers (scanned, matched_count) — the fact that an import happened, with
 *     no content. The 5/hour budget is an in-memory counter, precisely so that
 *     even the rate limit leaves no row behind.
 *
 * Statuses: 401 unauthenticated · 400 invalid_body · 400 no_contacts ·
 *           400 csv_parse_error · 413 payload_too_large · 429 rate_limited ·
 *           200 with { scanned, matched_count, matched[], unmatched_count }.
 */

/**
 * Imports per account per hour. Declared in src/domain/contact-match.ts because
 * the Google Contacts endpoint shares this exact budget — the two doors answer
 * the same question and must not double it.
 */
export { CONTACTS_IMPORT_PER_HOUR };

const WINDOW_MS = 60 * 60 * 1000;

async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = await readJsonBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return jsonError(400, 'invalid_body', 'JSON object expected', { headers: privateCacheHeaders() });
    }
    const fields = body as Record<string, unknown>;
    const content = typeof fields.content === 'string' ? fields.content : null;
    if (content === null || content.trim().length === 0) {
      return jsonError(400, 'invalid_body', 'content (the address book text) is required', {
        headers: privateCacheHeaders(),
      });
    }
    const filename = typeof fields.filename === 'string' ? fields.filename : undefined;

    // O(1) size guard first: an oversized body is refused before it can cost
    // anything, and (like every other malformed request) before it can spend a
    // token of the hourly budget.
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > CONTACT_IMPORT_MAX_BYTES) {
      return jsonError(
        413,
        'payload_too_large',
        `Address book exceeds the ${Math.round(CONTACT_IMPORT_MAX_BYTES / 1024 / 1024)} MB limit`,
        { headers: privateCacheHeaders() },
      );
    }

    // 5/hour/account, in-memory (src/lib/ratelimit.ts consumeSubjectToken): a
    // table-backed counter would be a stored fact about the import, which is
    // exactly what this endpoint promises not to keep.
    const verdict = consumeSubjectToken(auth.accountId, 'contacts_import', {
      capacity: CONTACTS_IMPORT_PER_HOUR,
      windowMs: WINDOW_MS,
    });
    const rateHeaders = {
      'X-RateLimit-Limit': String(CONTACTS_IMPORT_PER_HOUR),
      'X-RateLimit-Remaining': String(verdict.remaining),
      'X-RateLimit-Reset': String(Math.ceil((verdict.nowMs + verdict.retryAfterMs) / 1000)),
    };
    if (!verdict.allowed) {
      return jsonError(429, 'rate_limited', 'Too many import requests. Try again later.', {
        retryable: true,
        headers: {
          ...privateCacheHeaders(),
          ...rateHeaders,
          'Retry-After': String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))),
        },
      });
    }

    const parsed = parseContacts(content, { filename });
    if (!parsed.ok) {
      return jsonError(parsed.code === 'payload_too_large' ? 413 : 400, parsed.code, parsed.message, {
        headers: { ...privateCacheHeaders(), ...rateHeaders },
      });
    }
    if (parsed.truncated) {
      return jsonError(
        413,
        'payload_too_large',
        `Address book exceeds the ${CONTACT_IMPORT_MAX_CONTACTS}-contact limit`,
        { headers: { ...privateCacheHeaders(), ...rateHeaders } },
      );
    }

    const pepper = requireHashPepper();

    // Matching lives in one place for both import doors — the address book and
    // Google Contacts (Phase 2) — so the privacy contract is a property of the
    // code path rather than of this file (src/domain/contact-match.ts).
    const sql = getSql();
    const result = await matchContactEmails(sql, {
      accountId: auth.accountId,
      emails: parsed.contacts.map((contact) => contact.email),
      pepper,
    });

    // The one trace: what happened, in numbers, without any content.
    await recordContactMatchAudit(sql, auth.accountId, parsed.format, {
      scanned: result.scanned,
      matched_count: result.matched_count,
      skipped: parsed.skipped,
    });

    return jsonOk(
      {
        ok: true,
        scanned: result.scanned,
        matched_count: result.matched_count,
        matched: result.matched,
        unmatched_count: result.unmatched_count,
        matched_truncated: result.matched_truncated,
        skipped: parsed.skipped,
      },
      { headers: { ...privateCacheHeaders(), ...rateHeaders } },
    );
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { decryptValue } from '../../../../lib/crypto';
import { requireEncryptionKey } from '../../../../lib/env';
import { internalError, jsonError, jsonOk, privateCacheHeaders, withApi } from '../../../../lib/http';
import { checkRateLimit } from '../../../../lib/ratelimit';
import {
  MAX_ENRICHMENT_LINKS,
  selectEnrichmentProvider,
} from '../../../../integrations/enrichment';

/** Rate limit: 5 enrichment calls per account per hour (DB-backed, same
 * fact-row pattern as otp_verify_failures / mfa_verify_failures). */
export const ENRICHMENT_RATE_LIMIT_PER_HOUR = 5;

/** Contacts that may be handed to the provider as the user's OWN links. */
function ownLinks(contacts: { kind: string; value: string }[]): string[] {
  const out: string[] = [];
  for (const contact of contacts) {
    let candidate: string | null = null;
    if (contact.kind === 'website') {
      candidate = /^https?:\/\//i.test(contact.value) ? contact.value : `https://${contact.value}`;
    } else if (contact.kind === 'linkedin_url') {
      candidate = /^https?:\/\//i.test(contact.value) ? contact.value : `https://${contact.value}`;
    } else if (contact.kind === 'telegram_username') {
      const handle = contact.value.replace(/^@/, '').trim();
      candidate = handle.length > 0 ? `https://t.me/${encodeURIComponent(handle)}` : null;
    }
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (!url.hostname.includes('.')) continue;
      if (!out.includes(candidate)) out.push(candidate);
    } catch {
      continue;
    }
    if (out.length >= MAX_ENRICHMENT_LINKS) break;
  }
  return out;
}

/**
 * POST /api/me/enrich — user-initiated, own-data-only profile enrichment.
 *
 * Privacy contract (docs-internal/product/ONBOARDING_MINI_LANDING.md):
 *   - authenticated caller only; the request carries ONLY their own data
 *     (display name, company, industry, their own confirmed links);
 *   - NO user content is persisted — the response is a draft the user must
 *     confirm line by line in the UI; the only DB write is the rate-limit
 *     ledger row (account_id + created_at) in enrichment_requests;
 *   - no third-party / bulk enrichment, no LinkedIn scraping.
 *
 * Statuses: 401 unauthenticated · 503 enrichment_disabled (retryable:false)
 *           · 429 rate_limited · 502 enrichment_failed (retryable:true).
 */
async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    // Resolve the provider first: a disabled provider must not burn the quota.
    const provider = await selectEnrichmentProvider();
    if (!provider.enabled) {
      return jsonError(503, 'enrichment_disabled', 'Enrichment is not available right now.', {
        retryable: false,
        headers: privateCacheHeaders(),
      });
    }

    const sql = getSql();
    const limit = await checkRateLimit(sql, {
      table: 'enrichment_requests',
      subjectColumn: 'account_id',
      subjectId: auth.accountId,
      windowMinutes: 60,
      max: ENRICHMENT_RATE_LIMIT_PER_HOUR,
    });
    if (limit.limited) {
      return jsonError(429, 'rate_limited', 'Too many enrichment requests. Try again later.', {
        retryable: true,
        headers: {
          ...privateCacheHeaders(),
          'Retry-After': String(limit.retryAfterSeconds),
          'X-RateLimit-Limit': String(ENRICHMENT_RATE_LIMIT_PER_HOUR),
          'X-RateLimit-Remaining': '0',
        },
      });
    }
    await sql`INSERT INTO enrichment_requests (account_id) VALUES (${auth.accountId})`;

    const profileRows = await sql<{
      display_name: string;
      company: string | null;
      industry: string | null;
    }[]>`
      SELECT display_name, company, industry FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1
    `;
    const profile = profileRows[0];
    if (!profile) {
      return jsonError(400, 'profile_required', 'Create your profile before enriching it');
    }

    const contactRows = await sql<{ kind: string; encrypted_value: string }[]>`
      SELECT cf.kind, cf.encrypted_value
      FROM contact_fields cf
      JOIN profiles p ON p.id = cf.profile_id
      WHERE p.account_id = ${auth.accountId}
      ORDER BY cf.updated_at ASC
    `;
    // Best-effort decryption: a row written under a different key (key rotation,
    // restored backup) or otherwise corrupt must never fail the whole request —
    // it simply is not a link we can hand over, so enrichment proceeds with the
    // contacts that do decrypt. Same rule as GET /api/me/contacts.
    const key = requireEncryptionKey();
    const contacts: { kind: string; value: string }[] = [];
    for (const row of contactRows) {
      try {
        contacts.push({ kind: row.kind, value: decryptValue(row.encrypted_value, key) });
      } catch {
        continue;
      }
    }

    const result = await provider.enrich({
      displayName: profile.display_name,
      company: profile.company,
      industry: profile.industry,
      links: ownLinks(contacts),
    });

    if (result.state !== 'ok' || !result.draft) {
      // Never leak provider internals; the client just retries.
      return jsonError(502, 'enrichment_failed', 'Enrichment provider did not return a draft.', {
        retryable: result.retryable ?? true,
        headers: privateCacheHeaders(),
      });
    }

    return jsonOk(
      {
        ok: true,
        draft: result.draft,
        sources: result.sources ?? [],
        provider: result.provider ?? provider.name,
      },
      { headers: privateCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

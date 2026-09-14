import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { decryptValue } from '../../../../lib/crypto';
import { requireEncryptionKey } from '../../../../lib/env';
import { internalError, jsonError, jsonOk, privateCacheHeaders, withApi } from '../../../../lib/http';
import { checkRateLimit } from '../../../../lib/ratelimit';
import { degradedEnrichmentDraft, selectEnrichmentProvider } from '../../../../integrations/enrichment';
import {
  ENRICHMENT_RATE_LIMIT_PER_HOUR,
  MAX_ENRICHMENT_LINKS,
} from '../../../../domain/enrichment-limits';
import { labelFor, parseCatalog } from '../../../../domain/picker';
import { taxonomyPayload } from '../../../../domain/taxonomy';
import { getLocale, type Locale } from '../../../../i18n';

/** Provider outcomes that mean "reachable, but no usable draft" — the ones the
 * deterministic fallback answers instead of a 502. Everything else (auth,
 * network, timeout, upstream 4xx/5xx) is a real failure. */
const NO_DRAFT_CODES = new Set(['no_draft', 'bad_response']);

/** Rate limit: 5 enrichment calls per account per hour (DB-backed, same
 * fact-row pattern as otp_verify_failures / mfa_verify_failures).
 * The number lives in src/domain/enrichment-limits.ts so the UI can quote it. */
export { ENRICHMENT_RATE_LIMIT_PER_HOUR };

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
 * Human label for one of the caller's OWN taxonomy ids (industry / job
 * function), resolved through the same catalogue the profile editor uses. The
 * raw id is the fallback; unknown ids are never turned into invented text.
 */
function ownAxisLabel(axis: 'industries' | 'functions', id: string | null, locale: Locale): string | null {
  if (!id) return null;
  const catalog = parseCatalog(taxonomyPayload());
  const hit = catalog?.[axis].find((item) => item.id === id);
  return hit ? labelFor(hit.label, locale) : id;
}

/**
 * POST /api/me/enrich — user-initiated, own-data-only profile enrichment.
 *
 * Privacy contract (docs-internal/product/ONBOARDING_MINI_LANDING.md):
 *   - authenticated caller only; the request carries ONLY their own data
 *     (display name, company, industry, job function, their own confirmed links);
 *   - NO user content is persisted — the response is a draft the user must
 *     confirm line by line in the UI; the only DB write is the rate-limit
 *     ledger row (account_id + created_at) in enrichment_requests;
 *   - no third-party / bulk enrichment, no LinkedIn scraping.
 *
 * Statuses: 401 unauthenticated · 503 enrichment_disabled (retryable:false)
 *           · 429 rate_limited · 200 with a draft — `degraded: true` when the
 *           provider contributed nothing and the draft was built from the
 *           caller's own profile fields (see below) · 502 enrichment_failed
 *           (retryable:true) only for real provider failures.
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
      job_function: string | null;
    }[]>`
      SELECT display_name, company, industry, job_function FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1
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
      jobFunction: profile.job_function,
      links: ownLinks(contacts),
    });

    if (result.state === 'ok' && result.draft) {
      return jsonOk(
        {
          ok: true,
          draft: result.draft,
          sources: result.sources ?? [],
          provider: result.provider ?? provider.name,
        },
        { headers: privateCacheHeaders() },
      );
    }

    // BUG-3b: the provider was reachable but produced no usable draft (the
    // transport already retried once). The actionable content of a thin
    // footprint is "nothing new found — confirm what you told us", not a 502:
    // a failed call left the onboarding/profile panel with no rows at all on a
    // perfectly valid profile. The fallback is deterministic, built only from
    // the caller's own fields (src/integrations/enrichment/degraded-draft.ts)
    // and flagged `degraded: true`, so the client can tell it apart from a
    // provider result while the UI always gets confirmable rows. Nothing is
    // persisted either way, and no catalogue id or link is ever invented.
    if (NO_DRAFT_CODES.has(result.code ?? '')) {
      // BUG-4: the provider's own code must leave a server-side trace. The
      // client is never told why (no provider internals leak), which is exactly
      // why the diagnosis has to be possible from the logs: code + status only,
      // no PII, no secrets, no request/response bodies.
      console.error(
        `[enrich] degraded fallback provider=${provider.name} state=${result.state} code=${result.code ?? 'none'} retryable=${String(result.retryable ?? 'n/a')}`,
      );
      const locale = await getLocale().catch(() => 'en' as Locale);
      const draft = degradedEnrichmentDraft({
        displayName: profile.display_name,
        company: profile.company,
        jobFunction: ownAxisLabel('functions', profile.job_function, locale),
        industry: ownAxisLabel('industries', profile.industry, locale),
      });
      return jsonOk(
        { ok: true, draft, sources: [], provider: provider.name, degraded: true },
        { headers: privateCacheHeaders() },
      );
    }

    // Real provider failure (auth, network, timeout, upstream 4xx/5xx): reported
    // as a retryable 502 — with the same non-PII server-side trace.
    console.error(
      `[enrich] provider failed provider=${provider.name} state=${result.state} code=${result.code ?? 'none'} retryable=${String(result.retryable ?? 'n/a')}`,
    );
    return jsonError(502, 'enrichment_failed', 'Enrichment provider did not return a draft.', {
      retryable: result.retryable ?? true,
      headers: privateCacheHeaders(),
    });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

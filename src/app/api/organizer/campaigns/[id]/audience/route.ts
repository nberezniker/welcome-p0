import { NextRequest } from 'next/server';
import { getSql } from '../../../../../../lib/db';
import { requireAccount } from '../../../../../../lib/auth';
import { withRequestContext, privateCacheHeaders, jsonError, jsonOk, internalError } from '../../../../../../lib/http';
import {
  audienceFilterIsEmpty,
  currentEligibleAudience,
  loadCampaignWithRole,
  normalizeAudienceFilter,
  validateAudienceFilter,
  type AudienceFilter,
} from '../../../../../../domain/campaigns';

/**
 * GET /api/organizer/campaigns/[id]/audience — live audience preview.
 * Returns the eligible COUNT and up to 20 sample display_names ONLY — never
 * contact values, never full recipient lists (spec S08: предварительный
 * подсчёт допустимых адресатов).
 *
 * The count is exactly the set `send` will enqueue jobs for: active memberships,
 * the purpose consent, directory visibility for marketing, no blocks, no open
 * reports, no revoked/blocked binding — narrowed by the campaign's saved
 * `audience_filter` segment. `channel_ready` reports how many of them have a
 * reachable channel (active Telegram binding or an address on file), which is
 * what the send-time channel decision (ADR 0011) will use.
 *
 * Unsaved segments: the same five axes may be passed as query parameters
 * (`?need_intents=a,b&interests=x&job_function=y`), so the organizer can size a
 * segment BEFORE saving it. The effective filter is echoed back either way.
 */
/* Request scope only — a read-only GET takes no CSRF/rate-limit guard, but its
 * error bodies and log lines must still carry the request's correlation id. */
export const GET = withRequestContext(get);

async function get(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { id } = await params;
    const sql = getSql();
    const loaded = await loadCampaignWithRole(sql, auth.accountId, id);
    if (!loaded) return jsonError(404, 'not_found', 'Campaign not found');
    if (loaded.role === null) return jsonError(404, 'not_found', 'Campaign not found');
    if (loaded.role !== 'owner' && loaded.role !== 'admin') {
      return jsonError(403, 'forbidden', 'Only the organizer owner or admin can preview the audience');
    }

    const overridden = readFilterOverrides(req.nextUrl.searchParams);
    if (overridden === 'invalid') {
      return jsonError(400, 'invalid_audience_filter', 'Audience filter parameters must be catalogue ids');
    }
    const filter = overridden ?? normalizeAudienceFilter(loaded.campaign.audience_filter);

    const audience = await currentEligibleAudience(sql, {
      eventId: loaded.campaign.event_id,
      purpose: loaded.campaign.purpose,
      senderAccountId: auth.accountId,
      filter,
    });
    const accountIds = audience.map((a) => a.account_id);
    const withChannel = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM accounts a
      WHERE a.id = ANY(${accountIds}::uuid[])
        AND (
          EXISTS (
            SELECT 1 FROM channel_bindings cb
            WHERE cb.account_id = a.id AND cb.provider = 'telegram' AND cb.state = 'active'
          )
          OR EXISTS (
            SELECT 1 FROM event_memberships m
            JOIN profiles p ON p.id = m.profile_id
            JOIN registrations r ON r.id = m.registration_id
            WHERE p.account_id = a.id AND m.event_id = ${loaded.campaign.event_id}
              AND r.encrypted_email IS NOT NULL
          )
        )
    `;

    return jsonOk(
      {
        ok: true,
        audience: {
          count: audience.length,
          channel_ready: withChannel[0]?.count ?? 0,
          sample: audience.slice(0, 20).map((a) => ({ display_name: a.display_name })),
          filter,
          segment: !audienceFilterIsEmpty(filter),
        },
        snapshot_note: 'The binding audience snapshot is frozen at approve time and re-validated at send.',
      },
      { headers: privateCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

/**
 * Reads an unsaved segment from the query string. Returns null when no axis
 * parameter is present (use the stored filter), or 'invalid' when a value is not
 * in the catalogue. Comma-separated arrays; an unknown facet id is an error
 * rather than a silently ignored narrowing — a typo must never WIDEN a send.
 */
function readFilterOverrides(sp: URLSearchParams): AudienceFilter | null | 'invalid' {
  const anyPresent = ['need_intents', 'offer_intents', 'interests', 'job_function', 'industry'].some((k) => sp.has(k));
  if (!anyPresent) return null;
  const list = (key: string): string[] =>
    (sp.get(key) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  const parsed = validateAudienceFilter({
    need_intents: list('need_intents'),
    offer_intents: list('offer_intents'),
    interests: list('interests'),
    job_function: sp.get('job_function'),
    industry: sp.get('industry'),
  });
  return parsed.ok ? parsed.value : 'invalid';
}

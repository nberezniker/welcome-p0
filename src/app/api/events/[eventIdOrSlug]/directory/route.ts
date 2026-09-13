import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { jsonError, internalError } from '../../../../../lib/http';
import { isUuid } from '../../../../../domain/organizer';
import { eventViewCacheHeaders } from '../../../../../lib/event-view';
import {
  complementOf,
  validateIndustry,
  validateInterests,
  validateJobFunction,
} from '../../../../../domain/taxonomy';

export const dynamic = 'force-dynamic';

/** GET /api/events/[eventIdOrSlug]/directory — event directory for ACTIVE
 * members only. Strict field allowlist (profile_id + display fields + the three
 * taxonomy axes); no contacts, notes, emails, account ids or keywords.
 * Blocks suppress visibility in BOTH directions. directory_close_at closes it.
 *
 * Filter modes (TAXONOMY_V3.md §Search/UX):
 *   mode=all (default)   — everyone visible, optional facet filters
 *   mode=intent          — «ищут то же, что могу я»: members seeking what the
 *                          viewer offers (need_intents ∩ complement(viewer offers))
 *   mode=interest        — people sharing at least one interest with the viewer
 * plus explicit `interest` / `job_function` (alias `function`) / `industry`
 * facet filters and `q` — a free-text search over name / headline / company and
 * the member's own keywords. Keyword VALUES are matched but never projected:
 * the member object keeps its strict allowlist. */

const MODES = ['all', 'intent', 'interest'] as const;
type Mode = (typeof MODES)[number];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventIdOrSlug: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { eventIdOrSlug } = await params;
    const sql = getSql();
    const byId = isUuid(eventIdOrSlug);

    // --- query params (validated against the catalogue) -----------------------
    const sp = req.nextUrl.searchParams;
    const modeRaw = sp.get('mode') ?? 'all';
    if (!(MODES as readonly string[]).includes(modeRaw)) {
      return jsonError(400, 'invalid_mode', `mode must be one of: ${MODES.join(', ')}`);
    }
    const mode = modeRaw as Mode;

    const interestParam = sp.get('interest');
    if (interestParam !== null) {
      const check = validateInterests([interestParam]);
      if (!check.ok) return jsonError(400, check.code, check.message);
    }
    // `job_function` is the canonical param; `function` is the alias the
    // directory UI writes into the URL. Sending both is contradictory.
    const functionCanonical = sp.get('job_function');
    const functionAlias = sp.get('function');
    if (functionCanonical !== null && functionAlias !== null && functionCanonical !== functionAlias) {
      return jsonError(400, 'invalid_job_function', 'job_function and function disagree; send only one');
    }
    const functionParam = functionCanonical ?? functionAlias;
    if (functionParam !== null) {
      const check = validateJobFunction(functionParam);
      if (!check.ok) return jsonError(400, check.code, check.message);
    }
    const industryParam = sp.get('industry');
    if (industryParam !== null) {
      const check = validateIndustry(industryParam);
      if (!check.ok) return jsonError(400, check.code, check.message);
    }
    // Free-text search over the member's name / role / company and their own
    // keywords. Keyword VALUES are matched but never projected back — the member
    // list stays free of the keywords field (allowlist test).
    const qRaw = sp.get('q');
    const q = qRaw === null ? null : qRaw.trim().slice(0, 80);
    const qPattern = q === null || q.length === 0 ? null : `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

    const eventRows = await sql<{ id: string; directory_close_at: Date | null }[]>`
      SELECT id, directory_close_at FROM events
      WHERE ${byId ? sql`id = ${eventIdOrSlug}::uuid` : sql`slug = ${eventIdOrSlug}`}
      LIMIT 1
    `;
    const event = eventRows[0];
    if (!event) return jsonError(404, 'not_found', 'Event not found');

    // Membership override wins over the profile default, exactly like tags.
    const viewerRows = await sql<{
      id: string;
      need_intents: string[];
      offer_intents: string[];
      interests: string[];
    }[]>`
      SELECT m.id,
             COALESCE(NULLIF(m.need_intents, '{}'), pr.need_intents) AS need_intents,
             COALESCE(NULLIF(m.offer_intents, '{}'), pr.offer_intents) AS offer_intents,
             COALESCE(NULLIF(m.interests, '{}'), pr.interests) AS interests
      FROM event_memberships m
      JOIN profiles pr ON pr.id = m.profile_id
      WHERE m.event_id = ${event.id} AND pr.account_id = ${auth.accountId} AND m.state = 'active'
      LIMIT 1
    `;
    const viewer = viewerRows[0];
    if (!viewer) {
      return jsonError(403, 'forbidden', 'Only active members can see the event directory');
    }

    if (event.directory_close_at && new Date(event.directory_close_at).getTime() <= Date.now()) {
      return jsonError(403, 'directory_closed', 'The directory for this event is closed');
    }

    // --- mode filters (computed from the viewer's own catalogue values) -------
    let seekFilter: string[] | null = null;
    let interestFilter: string[] | null = null;
    if (mode === 'intent') {
      seekFilter = viewer.offer_intents
        .map((offer) => complementOf(offer))
        .filter((id): id is string => id !== null);
      // Nothing to look for → honest empty result, not a full directory dump.
      if (seekFilter.length === 0) {
        return NextResponse.json({ ok: true, mode, members: [] }, { headers: eventViewCacheHeaders() });
      }
    }
    if (mode === 'interest') {
      interestFilter = viewer.interests;
      if (interestFilter.length === 0) {
        return NextResponse.json({ ok: true, mode, members: [] }, { headers: eventViewCacheHeaders() });
      }
    }
    const interestFacet = interestParam === null ? null : [interestParam];

    const members = await sql<{
      profile_id: string; display_name: string; headline: string | null;
      company: string | null; offer_tags: string[]; need_tags: string[];
      need_intents: string[]; offer_intents: string[]; interests: string[];
      industry: string | null; job_function: string | null;
    }[]>`
      SELECT pr.id AS profile_id, pr.display_name, pr.headline, pr.company,
             m.offer_tags, m.need_tags,
             COALESCE(NULLIF(m.need_intents, '{}'), pr.need_intents) AS need_intents,
             COALESCE(NULLIF(m.offer_intents, '{}'), pr.offer_intents) AS offer_intents,
             COALESCE(NULLIF(m.interests, '{}'), pr.interests) AS interests,
             COALESCE(m.industry, pr.industry) AS industry,
             COALESCE(m.job_function, pr.job_function) AS job_function
      FROM event_memberships m
      JOIN profiles pr ON pr.id = m.profile_id
      JOIN accounts a ON a.id = pr.account_id
      WHERE m.event_id = ${event.id}
        AND m.state = 'active'
        AND m.directory_visible = true
        AND a.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_account_id = ${auth.accountId} AND b.target_account_id = a.id)
             OR (b.blocker_account_id = a.id AND b.target_account_id = ${auth.accountId})
        )
        AND (${seekFilter === null} OR COALESCE(NULLIF(m.need_intents, '{}'), pr.need_intents) && ${seekFilter ?? []}::text[])
        AND (${interestFilter === null} OR COALESCE(NULLIF(m.interests, '{}'), pr.interests) && ${interestFilter ?? []}::text[])
        AND (${interestFacet === null} OR COALESCE(NULLIF(m.interests, '{}'), pr.interests) @> ${interestFacet ?? []}::text[])
        AND (${functionParam === null} OR COALESCE(m.job_function, pr.job_function) = ${functionParam})
        AND (${industryParam === null} OR COALESCE(m.industry, pr.industry) = ${industryParam})
        AND (${qPattern === null} OR (
          pr.display_name ILIKE ${qPattern} ESCAPE '\'
          OR pr.headline ILIKE ${qPattern} ESCAPE '\'
          OR pr.company ILIKE ${qPattern} ESCAPE '\'
          OR EXISTS (
            SELECT 1 FROM unnest(COALESCE(NULLIF(m.keywords, '{}'), pr.keywords)) AS kw
            WHERE kw ILIKE ${qPattern} ESCAPE '\'
          )
        ))
      ORDER BY pr.display_name ASC, pr.id ASC
    `;

    return NextResponse.json(
      { ok: true, mode, members },
      { headers: eventViewCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

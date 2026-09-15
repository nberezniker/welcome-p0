import type { Sql } from 'postgres';
import { scorePair, type ScorePairResult } from './matching';
import {
  DEFAULT_RECOMMENDATION_MODE,
  NETWORKING_ALGORITHM,
  NETWORKING_ALGORITHM_V4,
  rankCandidates,
  reasonCodesFor,
  type RecommendationMode,
  type V4ExclusionReason,
} from './networking-score';
import type { Reason } from './reasons';
import type { ReasonV4 } from './reasons-v4';

/** Server-side eligibility + recommendations for one event.
 * The pure scorers decide the ranking; ALL eligibility is verified here against
 * the live DB (spec: production eligibility MUST be server-side).
 *
 * Layer order: candidates the v4 usefulness layer accepts come first (mode
 * `useful` by default), then the v3/legacy tag matches. A candidate that
 * qualifies in both layers appears once, with the v4 result. Profiles without
 * intents and interests never enter the v4 layer, so the pre-v4 behaviour is
 * preserved exactly.
 *
 * PRIVACY: only the VIEWER's goals are loaded. A candidate's goals are never
 * selected — they are private and have no business influencing anyone else's
 * ranking, not even as an accidental tie-breaker. */

export interface RecommendationItem {
  profile_id: string;
  display_name: string;
  headline: string | null;
  company: string | null;
  score: number;
  /** The mode this list was produced in (echoed per item for the client). */
  mode: RecommendationMode;
  /** Structural reasons for the VIEWER: what this candidate means to me. */
  reasons_for_me: Reason[];
  /** Structural reasons for the CANDIDATE: what I mean to them (mirrored). */
  reasons_for_them: Reason[];
  /** v4 line 1 «Польза» (design §B3). Empty for legacy tag matches. */
  reasons_useful: ReasonV4[];
  /** v4 line 2 «Развитие» (design §B3). Empty for legacy tag matches. */
  reasons_growth: ReasonV4[];
  algorithm: 'welcome_mutual_tags_v1' | typeof NETWORKING_ALGORITHM | typeof NETWORKING_ALGORITHM_V4;
}

export interface RecommendationsResult {
  items: RecommendationItem[];
  mode: RecommendationMode;
  /** Candidates the mode's gate rejected. */
  excluded_count: number;
  /** Why the list is empty; null when it is not. */
  excluded_reason: V4ExclusionReason | null;
}

interface CandidateRow {
  profile_id: string;
  display_name: string;
  headline: string | null;
  company: string | null;
  languages: string[];
  needs: string[];
  offers: string[];
  need_intents: string[];
  offer_intents: string[];
  interests: string[];
  industry: string | null;
  job_function: string | null;
  last_signal_at: Date | null;
  pending: number;
}

interface ViewerRow {
  need_tags: string[];
  offer_tags: string[];
  languages: string[];
  need_intents: string[];
  offer_intents: string[];
  interests: string[];
  industry: string | null;
  job_function: string | null;
  goals: string[];
}

/**
 * Top-`limit` explainable recommendations for the viewer within one event.
 * Eligibility: active membership + directory_visible + matching_enabled,
 * not self, no blocks either way, shared language (or either side unspecified),
 * no active pair in the event context and no pair of ANY state inside the
 * event's intro cooldown window.
 */
export async function recommendForEvent(
  sql: Sql,
  viewer: { accountId: string; profileId: string },
  eventId: string,
  limit = 3,
  mode: RecommendationMode = DEFAULT_RECOMMENDATION_MODE,
): Promise<RecommendationsResult> {
  // Cooldown lives on the event; read it once (default 30 per migration default).
  const eventRows = await sql<{ intro_cooldown_days: number }[]>`
    SELECT intro_cooldown_days FROM events WHERE id = ${eventId} LIMIT 1
  `;
  const cooldownDays = eventRows[0]?.intro_cooldown_days ?? 30;

  const rows = await sql<CandidateRow[]>`
    WITH viewer AS (
      SELECT pr.id AS profile_id, pr.languages, m.need_tags AS v_need, m.offer_tags AS v_offer
      FROM profiles pr
      JOIN event_memberships m ON m.profile_id = pr.id
      WHERE pr.id = ${viewer.profileId} AND m.event_id = ${eventId} AND m.state = 'active'
      LIMIT 1
    )
    SELECT
      pr.id AS profile_id,
      pr.display_name,
      pr.headline,
      pr.company,
      pr.languages,
      COALESCE(NULLIF(m.need_tags, '{}'), pr.need_tags) AS needs,
      COALESCE(NULLIF(m.offer_tags, '{}'), pr.offer_tags) AS offers,
      COALESCE(NULLIF(m.need_intents, '{}'), pr.need_intents) AS need_intents,
      COALESCE(NULLIF(m.offer_intents, '{}'), pr.offer_intents) AS offer_intents,
      COALESCE(NULLIF(m.interests, '{}'), pr.interests) AS interests,
      COALESCE(m.industry, pr.industry) AS industry,
      COALESCE(m.job_function, pr.job_function) AS job_function,
      -- Recency: a TIE-BREAKER only (never part of the usefulness formula).
      GREATEST(
        COALESCE(pr.updated_at, to_timestamp(0)),
        COALESCE(m.created_at, to_timestamp(0)),
        COALESCE((SELECT max(s.last_seen_at) FROM sessions s WHERE s.account_id = a.id), to_timestamp(0))
      ) AS last_signal_at,
      (
        SELECT count(*)::int FROM introductions pi
        WHERE pi.state = 'pending'
          AND (pi.profile_a = pr.id OR pi.profile_b = pr.id)
      ) AS pending
    FROM event_memberships m
    JOIN profiles pr ON pr.id = m.profile_id
    JOIN accounts a ON a.id = pr.account_id
    CROSS JOIN viewer v
    WHERE m.event_id = ${eventId}
      AND m.state = 'active'
      AND m.directory_visible = true
      AND m.matching_enabled = true
      AND pr.id <> v.profile_id
      AND a.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM blocks b
        WHERE (b.blocker_account_id = ${viewer.accountId} AND b.target_account_id = a.id)
           OR (b.blocker_account_id = a.id AND b.target_account_id = ${viewer.accountId})
      )
      AND (
        EXISTS (SELECT 1 FROM unnest(pr.languages) L(x) INTERSECT SELECT 1 FROM unnest(v.languages) L(x))
        OR cardinality(pr.languages) = 0
        OR cardinality(v.languages) = 0
      )
      AND NOT EXISTS (
        SELECT 1 FROM introductions i
        WHERE i.context_key = ${'event:' + eventId}
          AND ((i.profile_a = v.profile_id AND i.profile_b = pr.id)
            OR (i.profile_a = pr.id AND i.profile_b = v.profile_id))
          AND (
            i.state IN ('pending', 'mutual')
            OR i.created_at > now() - (${cooldownDays} * interval '1 day')
          )
      )
    ORDER BY pr.id ASC
  `;

  // Viewer values: membership override wins over profile defaults. `goals` have
  // no membership override by design (migration 011) and are the viewer's own.
  const viewerRows = await sql<ViewerRow[]>`
    SELECT COALESCE(NULLIF(m.need_tags, '{}'), pr.need_tags) AS need_tags,
           COALESCE(NULLIF(m.offer_tags, '{}'), pr.offer_tags) AS offer_tags,
           pr.languages,
           COALESCE(NULLIF(m.need_intents, '{}'), pr.need_intents) AS need_intents,
           COALESCE(NULLIF(m.offer_intents, '{}'), pr.offer_intents) AS offer_intents,
           COALESCE(NULLIF(m.interests, '{}'), pr.interests) AS interests,
           COALESCE(m.industry, pr.industry) AS industry,
           COALESCE(m.job_function, pr.job_function) AS job_function,
           pr.goals
    FROM profiles pr
    JOIN event_memberships m ON m.profile_id = pr.id
    WHERE pr.id = ${viewer.profileId} AND m.event_id = ${eventId}
    LIMIT 1
  `;
  const v = viewerRows[0];
  if (!v) return { items: [], mode, excluded_count: 0, excluded_reason: 'no_candidates' };

  const me = { id: viewer.profileId, eligible: true, needs: v.need_tags, offers: v.offer_tags };
  const meV3 = {
    id: viewer.profileId,
    eligible: true,
    needIntents: v.need_intents,
    offerIntents: v.offer_intents,
    interests: v.interests,
    industry: v.industry,
    jobFunction: v.job_function,
  };
  const meV4 = { ...meV3, goals: v.goals, recency: null };

  // v4: one greedy pass over every server-eligible candidate.
  const ranked = rankCandidates(
    meV4,
    rows.map((c) => ({
      id: c.profile_id,
      eligible: true as const,
      needIntents: c.need_intents,
      offerIntents: c.offer_intents,
      interests: c.interests,
      industry: c.industry,
      jobFunction: c.job_function,
      recency: c.last_signal_at ? new Date(c.last_signal_at).getTime() : null,
    })),
    mode,
    limit,
  );

  const byId = new Map(rows.map((c) => [c.profile_id, c]));
  const seen = new Set<string>();
  const items: RecommendationItem[] = [];

  for (const rankedItem of ranked.items) {
    const c = byId.get(rankedItem.id);
    if (!c) continue;
    seen.add(c.profile_id);
    items.push({
      profile_id: c.profile_id,
      display_name: c.display_name,
      headline: c.headline,
      company: c.company,
      score: rankedItem.score,
      mode,
      // The v3 fact list stays alongside the v4 two-line explanation: one is
      // "what we share", the other is "why it is worth your time".
      reasons_for_me: [...(reasonCodesFor(meV3, {
        id: c.profile_id,
        needIntents: c.need_intents,
        offerIntents: c.offer_intents,
        interests: c.interests,
        industry: c.industry,
        jobFunction: c.job_function,
      }) ?? [])],
      reasons_for_them: reasonCodesFor(
        {
          id: c.profile_id,
          needIntents: c.need_intents,
          offerIntents: c.offer_intents,
          interests: c.interests,
          industry: c.industry,
          jobFunction: c.job_function,
        },
        meV3,
      ),
      reasons_useful: [...rankedItem.reasons_useful],
      reasons_growth: [...rankedItem.reasons_growth],
      algorithm: NETWORKING_ALGORITHM_V4,
    });
  }

  // Legacy tag layer fills whatever is left of the list.
  const legacyItems: { c: CandidateRow; match: ScorePairResult }[] = [];
  for (const c of rows) {
    if (seen.has(c.profile_id)) continue;
    const match = scorePair(me, { id: c.profile_id, eligible: true, needs: c.needs, offers: c.offers });
    if (match) legacyItems.push({ c, match });
  }

  legacyItems.sort(
    (a, b) =>
      b.match.score - a.match.score ||
      a.c.pending - b.c.pending ||
      (a.c.profile_id < b.c.profile_id ? -1 : a.c.profile_id > b.c.profile_id ? 1 : 0),
  );

  for (const { c, match } of legacyItems) {
    if (items.length >= limit) break;
    if (seen.has(c.profile_id)) continue;
    seen.add(c.profile_id);
    items.push({
      profile_id: c.profile_id,
      display_name: c.display_name,
      headline: c.headline,
      company: c.company,
      score: match.score,
      mode,
      // Legacy tag path: the frozen tag strings become the same structural
      // shape, so the UI has exactly one reason renderer.
      reasons_for_me: match.reasonsForA.map((tag) => ({ code: 'shared_tag' as const, params: { tag } })),
      reasons_for_them: match.reasonsForB.map((tag) => ({ code: 'shared_tag' as const, params: { tag } })),
      reasons_useful: [],
      reasons_growth: [],
      algorithm: match.algorithm,
    });
  }

  return {
    items: items.slice(0, limit),
    mode,
    excluded_count: ranked.excluded_count,
    excluded_reason: items.length > 0 ? null : ranked.excluded_reason,
  };
}

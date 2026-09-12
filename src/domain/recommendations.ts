import type { Sql } from 'postgres';
import { scorePair, type ScorePairResult } from './matching';
import {
  NETWORKING_ALGORITHM,
  reasonsFor,
  scoreNetworking,
  type ReasonLocale,
} from './networking-score';

/** Server-side eligibility + recommendations for one event.
 * The pure scorePair decides the legacy tag score; ALL eligibility is verified
 * here against the live DB (spec: production eligibility MUST be server-side).
 *
 * Layer order (TAXONOMY_V3.md): candidates that match on the v3 axes
 * (intent / interest / function+industry) come first, then the legacy tag
 * matches. A candidate that qualifies in both layers appears once, with the v3
 * result. Profiles without intents and interests never enter the v3 layer, so
 * the pre-v3 behaviour is preserved exactly. */

export interface RecommendationItem {
  profile_id: string;
  display_name: string;
  headline: string | null;
  company: string | null;
  score: number;
  /** Viewer's needs covered by the candidate's offers (fact-based). */
  reasons_for_me: string[];
  /** Candidate's needs covered by the viewer's offers (fact-based). */
  reasons_for_them: string[];
  algorithm: 'welcome_mutual_tags_v1' | typeof NETWORKING_ALGORITHM;
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
}

/**
 * Top-3 explainable recommendations for the viewer within one event.
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
  locale: ReasonLocale = 'ru',
): Promise<RecommendationItem[]> {
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

  // Viewer values: membership override wins over profile defaults.
  const viewerRows = await sql<ViewerRow[]>`
    SELECT COALESCE(NULLIF(m.need_tags, '{}'), pr.need_tags) AS need_tags,
           COALESCE(NULLIF(m.offer_tags, '{}'), pr.offer_tags) AS offer_tags,
           pr.languages,
           COALESCE(NULLIF(m.need_intents, '{}'), pr.need_intents) AS need_intents,
           COALESCE(NULLIF(m.offer_intents, '{}'), pr.offer_intents) AS offer_intents,
           COALESCE(NULLIF(m.interests, '{}'), pr.interests) AS interests,
           COALESCE(m.industry, pr.industry) AS industry,
           COALESCE(m.job_function, pr.job_function) AS job_function
    FROM profiles pr
    JOIN event_memberships m ON m.profile_id = pr.id
    WHERE pr.id = ${viewer.profileId} AND m.event_id = ${eventId}
    LIMIT 1
  `;
  const v = viewerRows[0];
  if (!v) return [];

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

  const v3Items: { item: RecommendationItem; pending: number }[] = [];
  const legacyItems: { c: CandidateRow; match: ScorePairResult }[] = [];
  const seen = new Set<string>();

  for (const c of rows) {
    const candidateV3 = {
      id: c.profile_id,
      eligible: true,
      needIntents: c.need_intents,
      offerIntents: c.offer_intents,
      interests: c.interests,
      industry: c.industry,
      jobFunction: c.job_function,
    };
    const v3 = scoreNetworking(meV3, candidateV3, locale);
    if (v3 && v3.eligible) {
      seen.add(c.profile_id);
      v3Items.push({
        pending: c.pending,
        item: {
          profile_id: c.profile_id,
          display_name: c.display_name,
          headline: c.headline,
          company: c.company,
          score: v3.score,
          reasons_for_me: v3.reasons,
          reasons_for_them: reasonsFor(candidateV3, meV3, locale),
          algorithm: NETWORKING_ALGORITHM,
        },
      });
      continue;
    }
    const match = scorePair(me, { id: c.profile_id, eligible: true, needs: c.needs, offers: c.offers });
    if (match) legacyItems.push({ c, match });
  }

  v3Items.sort(
    (a, b) =>
      b.item.score - a.item.score ||
      a.pending - b.pending ||
      (a.item.profile_id < b.item.profile_id ? -1 : a.item.profile_id > b.item.profile_id ? 1 : 0),
  );

  legacyItems.sort(
    (a, b) =>
      b.match.score - a.match.score ||
      a.c.pending - b.c.pending ||
      (a.c.profile_id < b.c.profile_id ? -1 : a.c.profile_id > b.c.profile_id ? 1 : 0),
  );

  const merged: RecommendationItem[] = v3Items.map((x) => x.item);
  for (const { c, match } of legacyItems) {
    if (seen.has(c.profile_id)) continue;
    seen.add(c.profile_id);
    merged.push({
      profile_id: c.profile_id,
      display_name: c.display_name,
      headline: c.headline,
      company: c.company,
      score: match.score,
      reasons_for_me: match.reasonsForA,
      reasons_for_them: match.reasonsForB,
      algorithm: match.algorithm,
    });
  }

  return merged.slice(0, limit);
}

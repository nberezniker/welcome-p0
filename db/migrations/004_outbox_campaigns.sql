-- WELCOME P0 migration 004 — Phase 3: async delivery core.
-- Adds:
--   + campaigns.body_text / audience_filter / queued_count / sent_count
--   + campaigns purpose CHECK (closed registry: organizer_marketing | service_channel)
--   + campaign_audience table (audience snapshot frozen at approve time)
--   + link_challenges.proof_flags (two-sided channel binding: web confirm + /start)
-- Append-only: existing 001-003 columns and CHECK constraints are kept.

ALTER TABLE campaigns
  ADD COLUMN body_text text,
  ADD COLUMN audience_filter jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN queued_count int NOT NULL DEFAULT 0,
  ADD COLUMN sent_count int NOT NULL DEFAULT 0;

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_purpose_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_purpose_check
  CHECK (purpose IN ('organizer_marketing', 'service_channel'));

ALTER TABLE campaigns ADD CONSTRAINT campaigns_body_text_check
  CHECK (body_text IS NULL OR char_length(body_text) BETWEEN 1 AND 4000);

-- Frozen audience snapshot: one row per (campaign, account). Re-snapshots on
-- re-approve REPLACE the rows (see src/domain/campaigns.ts), never append duplicates.
CREATE TABLE campaign_audience (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  channel text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, account_id)
);
CREATE INDEX campaign_audience_campaign_idx ON campaign_audience(campaign_id);

-- Two-sided binding proof (AC-11): a stolen deep-link token alone must never
-- create a binding. The web session must confirm the same challenge first.
ALTER TABLE link_challenges
  ADD COLUMN proof_flags jsonb NOT NULL DEFAULT '{}';

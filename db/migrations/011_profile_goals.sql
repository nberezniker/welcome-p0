-- WELCOME P0 migration 011 — profile goals (matching v4, social/matching design §B2).
-- Append-only: 001-010 columns/CHECKs are untouched.
--
--   profiles.goals text[] — up to 3 goal ids from the curated catalogue in
--   src/domain/goals.ts, ORDERED BY PRIORITY (the array position is the
--   priority; deduplication keeps the first occurrence).
--
-- PRIVACY (design §B2, §C «нерушимо»):
--   goals are NEVER published. They do not appear in the public card, the vCard,
--   the OG metadata or the event directory; they are read only for the OWNER'S
--   OWN recommendations, so they are deliberately NOT mirrored on
--   event_memberships (unlike the v3 axes, which a membership may override).
--   The column lives on `profiles` only.
--
-- Empty array (the default, and every pre-011 row) means "no goal set" — the
-- scorer must treat that as "no signal", never as a mismatch.
--
-- The GIN index is for the owner-side queries the matching v4 layer may add
-- (e.g. "who shares my goal"); it is created now so the column and its access
-- path ship together. `IF NOT EXISTS` keeps the file safe to execute twice.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS goals text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS profiles_goals_gin ON profiles USING gin (goals);

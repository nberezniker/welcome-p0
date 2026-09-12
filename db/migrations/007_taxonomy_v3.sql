-- WELCOME P0 migration 007 — TAXONOMY v3: three first-class axes
-- (intent complementary / interest shared / function+industry relevance).
-- Append-only: 001-006 columns and CHECKs are untouched, and the legacy
-- offer_tags / need_tags columns stay in place for the frozen scorePair core.
--
-- New columns, identical names on BOTH profiles and event_memberships so a
-- membership can override the profile value per event (same rule as tags):
--   need_intents  text[] — intent ids the member is LOOKING for (<=3)
--   offer_intents text[] — intent ids the member OFFERS (complements; <=3)
--   interests     text[] — curated interest ids (<=5, catalog-only)
--   industry      text   — one industry id (NULL = unspecified / prefer-not-to-say)
--   job_function  text   — one function id (NULL = unspecified / prefer-not-to-say)
--   keywords      text[] — free text, <=5 x <=40 chars; never a matching gate
--
-- All ids are validated in code against src/domain/taxonomy.ts (the catalogue is
-- the single source of truth); the DB stores the canonical ids as plain text[].
-- `IF NOT EXISTS` keeps the file safe to execute twice (idempotent by hand as
-- well as through schema_migrations).
--
-- GIN indexes cover the directory filters: `interests && $1`,
-- `need_intents && $1`, `offer_intents && $1` (array overlap/containment).
--
-- enrichment_requests: fact rows (same shape as otp_verify_failures, migration
-- 005) used as the DB-backed rate limit for POST /api/me/enrich (5/hour/account).
-- It stores ONLY account_id + created_at — no user content, no draft, no sources.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS need_intents text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS offer_intents text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS interests text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS job_function text,
  ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}';

ALTER TABLE event_memberships
  ADD COLUMN IF NOT EXISTS need_intents text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS offer_intents text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS interests text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS job_function text,
  ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS profiles_need_intents_gin ON profiles USING gin (need_intents);
CREATE INDEX IF NOT EXISTS profiles_offer_intents_gin ON profiles USING gin (offer_intents);
CREATE INDEX IF NOT EXISTS profiles_interests_gin ON profiles USING gin (interests);
CREATE INDEX IF NOT EXISTS profiles_keywords_gin ON profiles USING gin (keywords);

CREATE INDEX IF NOT EXISTS event_memberships_need_intents_gin ON event_memberships USING gin (need_intents);
CREATE INDEX IF NOT EXISTS event_memberships_offer_intents_gin ON event_memberships USING gin (offer_intents);
CREATE INDEX IF NOT EXISTS event_memberships_interests_gin ON event_memberships USING gin (interests);
CREATE INDEX IF NOT EXISTS event_memberships_keywords_gin ON event_memberships USING gin (keywords);

CREATE TABLE IF NOT EXISTS enrichment_requests (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enrichment_requests_account_time_idx
  ON enrichment_requests(account_id, created_at);

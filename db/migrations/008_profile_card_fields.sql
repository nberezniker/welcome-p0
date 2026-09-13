-- WELCOME P0 migration 008 — mini-landing («карточка») fields.
-- Append-only: 001-007 columns/CHECKs are untouched. Two additive changes:
--
--   1. contact_fields.kind gains 'github_url'. The design doc
--      (docs-internal/product/ONBOARDING_MINI_LANDING.md §«Подгрузить и
--      подтвердить») lists LinkedIn / сайт / GitHub / Telegram / WhatsApp as the
--      link kinds the user confirms by hand, so GitHub needs its own kind —
--      reusing 'website' would collide with UNIQUE(profile_id, kind) for a user
--      who has both a site and a GitHub profile.
--
--   2. profiles.hidden_fields text[] — per-field "publish in my card" opt-outs.
--      SEMANTICS: an EMPTY array (the default, and every pre-008 row) means
--      "nothing hidden" → the public projection is unchanged for existing
--      profiles. A field id in the array is withheld from the public card
--      It is a deny list, not an allow list, so the safe default (everything
--      public) can never be inverted by a partial or missing write.
--      Field ids are validated in code against PUBLIC_FIELD_IDS
--      (src/domain/profile.ts); the DB stores plain ids.
--
-- Both statements are safe to execute twice (IF EXISTS / IF NOT EXISTS), which
-- is how the taxonomy-v3 migration is maintained too.

ALTER TABLE contact_fields DROP CONSTRAINT IF EXISTS contact_fields_kind_check;
ALTER TABLE contact_fields ADD CONSTRAINT contact_fields_kind_check
  CHECK (kind IN ('whatsapp', 'telegram_username', 'linkedin_url', 'website', 'phone', 'github_url'));

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hidden_fields text[] NOT NULL DEFAULT '{}';

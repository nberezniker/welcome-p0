-- WELCOME P0 migration 002 — Phase 2: events settings, matching flags, consent
-- purpose CHECK, revoked intro state, registration claim challenges, blocks, reports.
-- Interpretations per approved Phase 2 plan:
--   ③ approval_status normalization lives in src/domain/csv.ts (DB keeps the value as imported)
--   ④ blocks/reports are NEW tables here (absent from the 001 schema contract)
--   ⑤ introductions.state CHECK gains 'revoked' (withdraw before mutual)

ALTER TABLE events
  ADD COLUMN join_code text,
  ADD COLUMN directory_close_at timestamptz,
  ADD COLUMN intro_cooldown_days int NOT NULL DEFAULT 30;

-- Join codes are per-event secrets; uniqueness prevents collisions when set.
CREATE UNIQUE INDEX events_join_code_uq ON events(join_code) WHERE join_code IS NOT NULL;

-- An account owns at most one organizer (role=owner); staff/admin may serve many.
CREATE UNIQUE INDEX organizer_members_owner_uq ON organizer_members(account_id) WHERE role = 'owner';

ALTER TABLE event_memberships
  ADD COLUMN matching_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN attendance_source text NOT NULL DEFAULT 'none'
    CHECK (attendance_source IN ('none','self','organizer_checkin'));

-- Purpose registry is closed: matches src/domain/consent.ts CONSENT_PURPOSES.
ALTER TABLE consent_events
  ADD CONSTRAINT consent_events_purpose_check CHECK (purpose IN
    ('public_card','event_directory','introduction_fields','service_channel','organizer_marketing','product_marketing'));

-- State machine: withdraw before mutual → 'revoked'.
ALTER TABLE introductions DROP CONSTRAINT IF EXISTS introductions_state_check;
ALTER TABLE introductions ADD CONSTRAINT introductions_state_check
  CHECK (state IN ('pending','mutual','declined','blocked','closed','revoked'));

-- Registration claim challenges carry the registration they unlock.
ALTER TABLE link_challenges
  ADD COLUMN registration_id uuid REFERENCES registrations(id) ON DELETE SET NULL;

-- Blocks: symmetric visibility suppression. Self-block is meaningless → forbidden.
CREATE TABLE blocks (
  blocker_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_account_id, target_account_id),
  CHECK (blocker_account_id <> target_account_id)
);
CREATE INDEX blocks_target_idx ON blocks(target_account_id, blocker_account_id);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  reason text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

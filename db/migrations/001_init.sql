-- WELCOME P0 migration 001 — full schema contract (spec/implementation/schema-contract.sql)
-- Adaptations per Phase 1 brief:
--   + accounts.is_demo boolean default false (demo seed marker)
--   + accounts.email_lookup_hash (HMAC-SHA256 of email, lookup key; raw email is never stored)
--   + sessions table (server-side sessions for email-OTP auth)
--   + auth_otp_codes table (hashed OTP, attempts, TTL)
--   + worker_heartbeat table (liveness for /api/health)
--   + events extra columns (mode, access_mode, max_participants, location_label, online_link,
--     description, consent_text, networking_window_days)
--   - rate_limits table intentionally NOT created
-- All original contract tables, columns, checks and indexes are kept.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text UNIQUE NOT NULL,
  email_lookup_hash text UNIQUE,
  is_demo boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleting','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid UNIQUE NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_slug text UNIQUE NOT NULL,
  display_name text NOT NULL,
  headline text,
  company text,
  short_bio text,
  languages text[] NOT NULL DEFAULT '{}',
  offer_tags text[] NOT NULL DEFAULT '{}',
  need_tags text[] NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(public_slug) >= 22)
);

CREATE TABLE contact_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL,
  encrypted_value text NOT NULL,
  public_enabled boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(profile_id, kind)
);

CREATE TABLE organizers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizer_members (
  organizer_id uuid NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','staff')),
  PRIMARY KEY (organizer_id, account_id)
);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  mode text CHECK (mode IN ('offline','online','hybrid')),
  access_mode text CHECK (access_mode IN ('public','closed','registration')),
  max_participants int,
  location_label text,
  online_link text,
  description text,
  consent_text text,
  networking_window_days int NOT NULL DEFAULT 30,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text NOT NULL DEFAULT 'UTC',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'csv',
  external_guest_id text,
  email_lookup_hash text,
  encrypted_email text,
  imported_name text,
  imported_data jsonb NOT NULL DEFAULT '{}',
  approval_status text NOT NULL DEFAULT 'unknown',
  claim_state text NOT NULL DEFAULT 'unclaimed' CHECK (claim_state IN ('unclaimed','claimed','quarantined')),
  import_revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX registrations_provider_guest_uq ON registrations(event_id, provider, external_guest_id) WHERE external_guest_id IS NOT NULL;
CREATE UNIQUE INDEX registrations_email_uq ON registrations(event_id, email_lookup_hash) WHERE external_guest_id IS NULL AND email_lookup_hash IS NOT NULL;

CREATE TABLE event_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  registration_id uuid REFERENCES registrations(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','hidden','left','blocked')),
  directory_visible boolean NOT NULL DEFAULT false,
  offer_tags text[] NOT NULL DEFAULT '{}',
  need_tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, profile_id)
);

CREATE TABLE channel_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  external_id text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','blocked')),
  last_inbound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, external_id),
  UNIQUE(account_id, provider)
);

CREATE TABLE link_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_events (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  scope_type text NOT NULL,
  scope_id text,
  field_set text[] NOT NULL DEFAULT '{}',
  policy_version text NOT NULL,
  action text NOT NULL CHECK (action IN ('grant','withdraw')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE introductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  profile_a uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_b uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  context_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','mutual','declined','blocked','closed')),
  reason jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (profile_a <> profile_b),
  UNIQUE(context_key, profile_a, profile_b)
);

CREATE TABLE introduction_consents (
  introduction_id uuid NOT NULL REFERENCES introductions(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('pending','accept','decline','withdraw')),
  reveal_fields text[] NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(introduction_id, profile_id)
);

CREATE TABLE connection_notes (
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  other_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  introduction_id uuid REFERENCES introductions(id) ON DELETE SET NULL,
  note_text text,
  next_step text,
  next_step_status text NOT NULL DEFAULT 'none' CHECK (next_step_status IN ('none','proposed','confirmed','done','dropped')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_account_id, other_profile_id)
);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  content_revision bigint NOT NULL DEFAULT 1,
  approved_revision bigint,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','running','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inbox_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  external_event_id text NOT NULL,
  event_type text,
  minimal_payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'received',
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, external_event_id)
);

CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text UNIQUE NOT NULL,
  kind text NOT NULL,
  subject_id uuid,
  channel text,
  purpose text NOT NULL,
  consent_version bigint,
  payload jsonb NOT NULL DEFAULT '{}',
  due_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','sent','delivered','failed','unknown','suppressed','cancelled')),
  lease_until timestamptz,
  attempt int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_ready_idx ON outbox_jobs(status, due_at);

CREATE TABLE delivery_attempts (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES outbox_jobs(id) ON DELETE CASCADE,
  provider_message_id text,
  state text NOT NULL,
  code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  actor_account_id uuid,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sessions for email-OTP auth. Only SHA-256 hash of the session token is stored.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_account_idx ON sessions(account_id);

-- Email OTP codes. 6-digit code is stored only as HMAC-SHA256 hash; max 5 verify attempts.
CREATE TABLE auth_otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_otp_codes_account_idx ON auth_otp_codes(account_id, created_at DESC);

-- Liveness heartbeat for the background worker, surfaced via /api/health.
CREATE TABLE worker_heartbeat (
  id boolean PRIMARY KEY DEFAULT true,
  beat_at timestamptz
);

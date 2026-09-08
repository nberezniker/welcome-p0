-- WELCOME P0 migration 005 — security hardening (F-02, F-06, F-13, F-14).
-- Append-only: existing 001-004 columns and CHECK constraints are kept.
--
-- F-02 (join_code brute-force): join_attempts is a fact log of FAILED code
--   attempts per (event, hashed IP). The join route counts the last 15 minutes
--   and locks at >= 20; a successful join clears the (event, ip) rows.
--   IPs are stored only as HMAC-SHA256(pepper) — no raw IPs at rest.
-- F-13 (otp_verify): per-account failed-verify window complements the
--   per-code attempts counter (auth_otp_codes.attempts).
-- F-14: DB CHECKs for contact_fields.kind (closed registry per
--   src/domain/profile.ts CONTACT_KINDS) and profiles.public_slug max length.
-- F-06: indexes the cleanup pass filters on.

-- ---------------------------------------------------------------------------
-- F-02: failed join-code attempts (facts only — no success/fail flag column;
-- every row IS a failed attempt).
-- ---------------------------------------------------------------------------
CREATE TABLE join_attempts (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ip_hash text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX join_attempts_event_ip_time_idx ON join_attempts(event_id, ip_hash, attempted_at);

-- ---------------------------------------------------------------------------
-- F-13: failed OTP verifications per account (fact rows, sliding 15-min window).
-- ---------------------------------------------------------------------------
CREATE TABLE otp_verify_failures (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_verify_failures_account_time_idx ON otp_verify_failures(account_id, attempted_at);

-- ---------------------------------------------------------------------------
-- F-14: schema-level validation.
-- NOTE (TODO, security): events.join_code is currently stored in PLAINTEXT and
-- compared constant-time in code. Before commercial launch it should be
-- replaced by a per-event HMAC/argon hash (dedicated migration + backfill).
-- ---------------------------------------------------------------------------
ALTER TABLE contact_fields ADD CONSTRAINT contact_fields_kind_check
  CHECK (kind IN ('whatsapp', 'telegram_username', 'linkedin_url', 'website', 'phone'));

ALTER TABLE profiles ADD CONSTRAINT profiles_public_slug_max_check
  CHECK (char_length(public_slug) <= 128);

-- ---------------------------------------------------------------------------
-- F-06: cleanup-pass indexes (full scans otherwise) + cleanup due-gate bookkeeping.
-- ---------------------------------------------------------------------------
ALTER TABLE worker_heartbeat ADD COLUMN IF NOT EXISTS last_cleanup_at timestamptz;

CREATE INDEX sessions_expires_idx ON sessions(expires_at);
CREATE INDEX auth_otp_codes_created_idx ON auth_otp_codes(created_at);
CREATE INDEX link_challenges_expires_idx ON link_challenges(expires_at);
CREATE INDEX outbox_terminal_created_idx ON outbox_jobs(created_at)
  WHERE status IN ('sent', 'delivered', 'failed', 'unknown', 'suppressed', 'cancelled');
CREATE INDEX inbox_events_received_idx ON inbox_events(received_at);
CREATE INDEX registrations_claim_state_idx ON registrations(claim_state, created_at);
CREATE INDEX accounts_deleting_updated_idx ON accounts(updated_at)
  WHERE status = 'deleting';

-- WELCOME P0 migration 006 — F-03: MFA (TOTP step-up) for organizer owners.
-- Append-only. Spec WELCOME_TZ_v3.md §9: "MFA для organizer owner".
--
-- mfa_credentials: one row per account (PK = unique = account_id). The TOTP
--   shared secret is stored ONLY encrypted (AES-256-GCM via src/lib/crypto.ts,
--   same key as contact_fields). confirmed_at IS NULL = enrollment pending —
--   the secret exists but the factor is not active yet.
-- mfa_recovery_codes: single-use codes, stored only as SHA-256 hashes
--   (code_hash); used_at marks consumption. 8 codes are (re)issued on enroll.
-- mfa_verify_failures: fact rows of failed MFA verifications per account —
--   same durable sliding-window pattern as otp_verify_failures (migration 005):
--   routes count the last 15 minutes and lock at >= 5.
-- sessions.mfa_verified_at: NULL = this session has not passed MFA. Step-up
--   policy (ADR 0007): owner-level organizer actions require a confirmed MFA
--   credential AND mfa_verified_at within the last 30 minutes.

CREATE TABLE mfa_credentials (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'totp',
  secret_encrypted text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

CREATE TABLE mfa_recovery_codes (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_recovery_codes_account_idx ON mfa_recovery_codes(account_id);
-- The verify path filters for an unused hash of this account on every MFA login.
CREATE INDEX mfa_recovery_codes_unused_idx ON mfa_recovery_codes(account_id, code_hash)
  WHERE used_at IS NULL;

CREATE TABLE mfa_verify_failures (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_verify_failures_account_time_idx ON mfa_verify_failures(account_id, attempted_at);

ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;

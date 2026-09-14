-- 010_session_last_seen.sql
-- Active-session management ("Активные устройства" on /me/security).
--
-- sessions previously recorded only created_at, which cannot order a device
-- list by recency. last_seen_at is refreshed by the auth guard at most once per
-- 5 minutes, so the column is a coarse "still in use" signal rather than a
-- request log.
--
-- Backfill note: existing rows get the migration timestamp because the true
-- last-seen time was never recorded and inventing a spread of values would
-- misrepresent history.
--
-- User-agent and IP are deliberately NOT stored anywhere, so the device list
-- can never leak them even by accident.
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

-- The list is always "this account, newest first".
CREATE INDEX sessions_account_seen_idx ON sessions(account_id, last_seen_at DESC);

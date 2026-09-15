-- WELCOME P0 migration 012 — post-event follow-up mechanics (Phase 4 of
-- docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md: §B5 + §D item 8).
-- Append-only: 001-011 columns/CHECKs are untouched except the ONE closed
-- purpose registry below, which is extended in place (see the note).
--
-- Two mechanics, both OFF BY DEFAULT and both gated by an env flag that a
-- deployment must set explicitly (FOLLOWUP_REMINDERS_ENABLED / DIGEST_ENABLED):
--
--   1. «next step» reminder — one message to the person who wrote their OWN
--      next_step, once per note per state transition;
--   2. weekly «who to meet» digest — at most 3 people, chosen from the
--      recipient's OWN goals and profile.
--
-- This migration is the BOOKKEEPING only. It sends nothing, schedules nothing
-- and answers no endpoint on its own: with the flags absent the worker never
-- scans these tables (src/infra/followup-scan.ts).
--
--   a) consent_events CHECK gains 'digest_weekly'.
--      The purpose registry is closed (migration 002) and must stay in sync with
--      src/domain/consent.ts CONSENT_PURPOSES. 'digest_weekly' is added the same
--      way the six existing purposes are declared — nothing else about consent
--      changes. The constraint is dropped and re-added (idempotent: IF EXISTS),
--      which is how 002/009 are maintained too; no existing row can violate the
--      widened list, so the re-add cannot fail on live data.
--      Consent for 'digest_weekly' is what the digest message's one-click
--      unsubscribe revokes, and a revoke is what suppresses an already queued
--      digest job (suppressJobsForAccountPurpose, via the existing path).
--      The reminder deliberately uses 'service_channel': it is a service message
--      about the recipient's own commitment, not marketing.
--
--   b) connection_notes gains the "already reminded" bookkeeping.
--      One reminder per note per state transition needs a durable record of
--      WHICH status was already reminded about; the outbox dedupe key alone
--      would be invisible to the scan. followup_reminded_status is nullable and
--      has no CHECK on purpose: it records a value of next_step_status that was
--      true at the time, and a migration must not be able to reject a historical
--      value if that enum ever grows.
--
--   c) followup_preferences — the explicit, timestamped, revocable opt-in.
--      Opt-in is NOT consent: consent says "this class of message is allowed",
--      the opt-in says "I asked for THIS mechanic". A message is enqueued only
--      when both hold. Two independent timestamp pairs, so neither mechanic can
--      be switched on by the other:
--        opted in  = opt_in_at IS NOT NULL AND (opt_out_at IS NULL OR opt_out_at < opt_in_at)
--      Storing the timestamps instead of a boolean keeps the decision auditable
--      and keeps "when did they ask for it" answerable after a re-opt-in.
--
--   d) digest_sends — who was already in someone's digest.
--      «already digested recently» cannot be reconstructed from the outbox once
--      a job's payload is minimized (applyOutcome drops payload text after
--      send), so the recipient/profile pair is recorded here at enqueue time.
--      job_id is a convenience link for operators; ON DELETE SET NULL so the
--      retention cleanup of old jobs can never destroy this history.
--
-- PRIVACY (design §C «нерушимо»): nothing in this migration stores a goal id, a
-- note text, an email address or any contact value. digest_sends stores profile
-- IDS — the same ids the recipient already sees in their own event directories.
-- goals stay on profiles (migration 011) and are read only for their OWNER.

ALTER TABLE consent_events DROP CONSTRAINT IF EXISTS consent_events_purpose_check;
ALTER TABLE consent_events ADD CONSTRAINT consent_events_purpose_check CHECK (purpose IN
  ('public_card','event_directory','introduction_fields','service_channel','organizer_marketing','product_marketing','digest_weekly'));

ALTER TABLE connection_notes ADD COLUMN IF NOT EXISTS followup_reminded_status text;
ALTER TABLE connection_notes ADD COLUMN IF NOT EXISTS followup_reminded_at timestamptz;

CREATE TABLE IF NOT EXISTS followup_preferences (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  reminders_opt_in_at timestamptz,
  reminders_opt_out_at timestamptz,
  digest_opt_in_at timestamptz,
  digest_opt_out_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS digest_sends (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  job_id uuid REFERENCES outbox_jobs(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);

-- The scan is always "this account, the people it already sent recently".
CREATE INDEX IF NOT EXISTS digest_sends_account_idx ON digest_sends(account_id, sent_at DESC);

-- The reminder scan walks notes with a step set and a mutual introduction.
CREATE INDEX IF NOT EXISTS connection_notes_next_step_idx ON connection_notes(updated_at)
  WHERE next_step IS NOT NULL AND next_step_status IN ('proposed','confirmed');

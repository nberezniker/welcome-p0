-- WELCOME P0 migration 009 — provenance of an introduction consent.
-- Append-only: 001-008 are untouched. One additive column plus a backfill.
--
--   introduction_consents.source — HOW the party agreed, two values:
--
--     'explicit'               — the party answered /respond themselves
--                                (decline, withdraw, and any accept);
--     'implicit_by_initiation' — the initiator agreed BY THE ACT of requesting:
--                                POST /api/introductions records their consent
--                                as decision 'accept' in the same transaction,
--                                so the pending → mutual transition needs only
--                                the SECOND party's accept (ADR 0010).
--
--   Without this column 'accept' is ambiguous: "agreed by requesting" and
--   "agreed by answering a request" collapse into one value, and neither the UI
--   nor the audit trail can tell the initiator from the counterparty.
--
--   The column is NULLABLE on purpose: NULL is the honest reading for a row
--   written by the pre-009 code path (a rolling deploy), and NULL is inert —
--   every reader treats "not implicit" as "explicit". Existing rows are
--   backfilled to 'explicit' because before 009 an 'accept' could only come
--   from an explicit /respond. DEFAULT 'explicit' keeps that reading for any
--   write that does not name a source.
--
-- Both statements are safe to run twice (IF EXISTS / IF NOT EXISTS), which is
-- how migrations 007 and 008 are maintained too.

ALTER TABLE introduction_consents ADD COLUMN IF NOT EXISTS source text;

UPDATE introduction_consents SET source = 'explicit' WHERE source IS NULL;

ALTER TABLE introduction_consents ALTER COLUMN source SET DEFAULT 'explicit';

ALTER TABLE introduction_consents DROP CONSTRAINT IF EXISTS introduction_consents_source_check;
ALTER TABLE introduction_consents ADD CONSTRAINT introduction_consents_source_check
  CHECK (source IS NULL OR source IN ('explicit', 'implicit_by_initiation'));

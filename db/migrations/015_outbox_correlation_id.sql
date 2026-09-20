-- WELCOME P0 migration 015 — the request correlation id of an outbox job.
-- Additive: one nullable column and one partial index; 001-014 are untouched.
--
-- WHY. An API error body carries `correlation_id` (src/lib/http.ts), and the log
-- line for that same request carries the same value, so a user's report resolves
-- to the server-side record. That chain stopped at the database boundary: a
-- request that enqueued outbox work left no trace of WHICH request created the
-- job, so a delivery failure in the worker ("job 4f2c… reclaimed three times")
-- could not be traced back to the request that produced it — and a request is
-- the only thing a user can name.
--
--   outbox_jobs.correlation_id  the id of the HTTP request that enqueued this
--                              job, or NULL.
--
-- NULL IS THE HONEST DEFAULT and there are two real sources of it:
--   1. jobs enqueued by the WORKER itself (the Phase-4 follow-up scan,
--      src/infra/followup-scan.ts) have no HTTP request behind them;
--   2. every row that already exists when this column appears.
-- A fabricated value (a fresh uuid per job) would be worse than NULL: it would
-- look like a request id an operator could grep for and find nothing.
--
-- Read path: the worker logs it next to job_id on a failure (src/infra/worker.ts),
-- and the runbook query is
--   SELECT id, kind, status, attempt FROM outbox_jobs WHERE correlation_id = '<id>';
--
-- Idempotent (IF NOT EXISTS), the same maintenance pattern migrations 002/009/012/
-- 014 use, so a re-apply cannot fail on a column that is already there.
ALTER TABLE outbox_jobs ADD COLUMN IF NOT EXISTS correlation_id text;

-- Partial, because the column is NULL for every worker-enqueued job: an index
-- over only the traced rows is smaller than a full one and is exactly the shape
-- the lookup above needs. It also keeps the index out of the way of the outbox's
-- own hot path, which never filters on this column.
CREATE INDEX IF NOT EXISTS outbox_correlation_idx
  ON outbox_jobs (correlation_id) WHERE correlation_id IS NOT NULL;

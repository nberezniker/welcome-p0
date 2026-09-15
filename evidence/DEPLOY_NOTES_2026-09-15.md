# Deploy notes — 2026-09-15 (packet 2)

Findings from running the live usage matrix against the production database.
Operational facts, not feature documentation.

## 1. Migration 010 must run BEFORE this code is deployed

**Symptom when it doesn't:** every authenticated request returns `500 internal_error`, with the server log
showing `column "last_seen_at" does not exist` (Postgres `42703`). Public pages, `/api/health` and the
unauthenticated flows keep working, which makes it look like an application bug rather than a missing
migration.

**Why:** `requireAccount` (src/lib/auth.ts) now refreshes `sessions.last_seen_at` on every authenticated
request, to feed the device list on `/me/security`.

**Measured:** the first live matrix run in this state scored **25 PASS / 87 FAIL** — the failures were all
this one cause. After applying 010 the same tree scored **112 PASS / 0 FAIL / 1 SKIP**.

**Fix:** `DATABASE_URL=<direct connection> node scripts/migrate.mjs`
(applied on 2026-09-15: migration `010` recorded in `schema_migrations`; `sessions.last_seen_at` and
`sessions_account_seen_idx` created; all pre-existing 82 session rows backfilled by the column default).

The migration is additive — one `ADD COLUMN ... NOT NULL DEFAULT now()` plus one index. On PostgreSQL 11+ it
does not rewrite the table, so it is safe to apply on a live database ahead of the code deploy.

**Recommended order for any deploy of this packet:** migrate the target database, then release the code.
The reverse order breaks sign-in for everyone for as long as the mismatch lasts.

### Follow-up worth doing

The matrix could fail fast instead of reporting 87 failures: a preflight that compares
`schema_migrations` in the target database against `db/migrations/*.sql` and aborts with
"migration <version> not applied to the target database" would turn a confusing cascade into one clear line.
Not implemented in this packet — it would have changed the script after the evidence run that documents it.

## 2. OTP budget is 3 codes per account per 15 minutes

`POST /api/auth/otp/request` throttles per account (3 per 15 min) on top of the per-IP bucket (10/min).
Live matrix runs therefore cannot be repeated back to back: a second run inside the same window fails with
`429 rate_limited` on every check that logs in, which reads like a broken deployment but is only the throttle.

The matrix already paces OTP requests; the constraint is the per-account window, not the pacing. Between two
full runs, wait out 15 minutes (or check
`SELECT count(*) FROM auth_otp_codes WHERE created_at > now() - interval '15 minutes'` for the account in use).

## 3. PITR / branch restore was not verified

See `BACKUP_RESTORE_REHEARSAL.md`: restoring a dump is proven, a point-in-time restore is not — no
`NEON_API_KEY` or `neonctl` was available. To close that gap, supply a Neon API key (with the project in
scope) and re-run `node scripts/backup-rehearsal.mjs`; it will exercise the branch path instead of recording
the limitation.

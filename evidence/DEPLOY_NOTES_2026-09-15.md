# Deploy notes — 2026-09-15 (packets 2 and 3)

Operational facts, not feature documentation. Sections 1–3 were written for
packet 2 (email channel, sessions, badges); the packet-3 section below is the one
that applies to the interop + matching-v4 work, and it comes FIRST because it is
the one that can break an environment.

## Packet 3 (interop + matching v4): migration 011 must run BEFORE the code

**What it is:** `db/migrations/011_profile_goals.sql` — one additive column and
one index:

```sql
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS goals text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS profiles_goals_gin ON profiles USING gin (goals);
```

**Already applied to the production database** (Neon `neondb`,
`ep-solitary-bread-b25sor11`) on 2026-09-15 ~10:05 UTC, before the live matrix run
of packet 3, which then scored 122 PASS / 0 FAIL / 1 SKIP (123 checks). On
PostgreSQL 11+ adding a column with a constant default does not rewrite the
table, so it is safe on a live database and ahead of the code.

**Symptom when it is missing:** `POST/GET /api/me/profile` and
`GET /api/events/<id>/recommendations` return `500 internal_error`, with
`column "goals" does not exist` (Postgres `42703`) in the server log. Public
pages, `/api/providers`, `/api/events/<id>/ics` and `/api/taxonomy` keep working,
so it looks like a partial outage rather than a missing migration. As with
migration 010, the order is: **migrate the target database, then release the
code**.

**Privacy note for anyone reading the column:** `profiles.goals` holds the
user's PRIVATE goals. It is never published (not in the public card, the vCard,
the OG metadata or the directory) and it is deliberately NOT mirrored on
`event_memberships` — unlike the v3 axes, there is no per-event override.

### Running the live matrix locally: two environment traps

Neither is a product defect; both cost a whole run if missed.

1. **The ADR-0009 OTP allowlist must contain every fixture login address.**
   The matrix signs in as its own synthetic accounts AND as the owner's account
   (`nberezniker@gmail.com`) and `matrix-claim@welcome.test`. In production
   without `RESEND_API_KEY` an OTP request for a non-allowlisted address is
   answered `503 email_channel_disabled`; the runner retries, those retries burn
   the per-account window (3 codes / 15 min), and every later check that needs
   the owner — sessions, imports, campaigns, tenant isolation, claims — fails in
   a cascade that looks like 39 unrelated bugs. `matrix-plain@welcome.test` must
   stay OFF the list: it is the anti-enumeration control.
2. **Enrichment needs three variables to be live:** `ENRICHMENT_PROVIDER=vertex-gemini`,
   `GCP_PROJECT_ID` and a credential source (`GCP_SA_JSON_B64` in the secrets
   file). Without them the route answers its honest 503 `enrichment_disabled`
   and checks F1/F2 report a gap of the local server, not of the deployment.

A third, older trap still applies: the matrix cannot be re-run back to back —
see «OTP budget is 3 codes per account per 15 minutes» below.


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

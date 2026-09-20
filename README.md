# WELCOME

[![CI](https://github.com/nberezniker/welcome-p0/actions/workflows/ci.yml/badge.svg)](https://github.com/nberezniker/welcome-p0/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Persistent personal networking profile + reusable QR: one profile you control,
a public card you can print on a QR badge, event matching and consent-gated
contact exchange, with Telegram as the P0 messaging channel.

**Status:** `PASS_LOCAL` (Phase 6 of 6, 2026-09-07) — see
[RELEASE_REPORT.md](RELEASE_REPORT.md) and [evidence/](evidence/).

**Live since 2026-09-15:** <https://welcome.colmogravity.net> (Vercel `fra1` + managed
Postgres, Frankfurt). The deployed instance runs the same tree as `main`, with a
synthetic demo event and demo accounts — it is not a claim of real users or
traction. Working end to end there: email one-time-code login, public card + QR,
event directory, consent-gated mutual contact reveal, Telegram as one of the
notice channels, organizer funnel. Growth/marketing surfaces stay behind the
honesty rules in `spec/` §7 (no invented customers, logos or benchmarks).

> That live instance is the author's own demonstration of this code, not a
> service you can sign up for: there is no hosted WELCOME, and nothing here talks
> to it. To get your own, see [SELF_HOSTING.md](SELF_HOSTING.md).

## Architecture

```
Next.js App Router (EN/RU/ES) ── /me, /p/:slug, /e/:slug, /login, /claim, /organizer
        │ withApi: CSRF origin guard + rate limits + error envelope
        ▼
Route handlers /api/* ─── src/domain (pure logic: matching, intros, consent,
        │                  csv/import, campaigns, vcard)
        ▼
postgres.js (no ORM) ── PostgreSQL 16, RLS-ready schema, db/migrations/*.sql
        ▲
src/infra: outbox (transactional jobs, backoff/lease) + worker (pnpm worker)
        ▼
Transports: telegram (real | mock[dev-only] | disabled) · Luma/WhatsApp/LinkedIn: disabled-by-default
```

Key invariants: public projection is explicit (`public_enabled`), contacts are
AES-256-GCM encrypted at rest, consent is purpose-scoped, outbox jobs are
suppressed (never silently dropped) when consent/transport/blocking says no.

## Run it yourself

Requirements: Node ≥20.9 (built on 22.x), pnpm 10.x, PostgreSQL 16+. **No
account on any external service is required** — the app runs with a local
database and two locally generated secrets.

```bash
pnpm install
createdb welcome_dev
cp .env.example .env.local        # 5 REQUIRED vars; every entry is labelled
openssl rand -base64 32           # → ENCRYPTION_KEY
openssl rand -base64 24           # → HASH_PEPPER
pnpm db:migrate                   # apply db/migrations
pnpm db:seed                      # optional: synthetic demo data (never in production)
pnpm dev                          # http://localhost:3000
pnpm worker                       # outbox worker (separate terminal)
```

Sign in with any address; the one-time code is appended to the gitignored
`.runtime/otp.log`. With no external keys, Telegram and email report
`disabled`/`not_configured` in `GET /api/providers` (naming the missing
variables), enrichment answers `503 enrichment_disabled`, and outbox jobs end as
`suppressed:no_channel` — nothing is mocked behind your back.

**Full walkthrough — your own Telegram bot, Resend, Google and Vertex
credentials, a custom domain, free-tier notes, and what this repo is *not*:
[SELF_HOSTING.md](SELF_HOSTING.md).** `.env.example` is the complete, labelled
list of variables the code reads; a unit test keeps the two in sync.

**Prefer containers?** `cp .env.example .env` (fill in the five required values
plus `POSTGRES_*`), then `docker compose up -d --build` brings up the app,
PostgreSQL and the migration job in one command — no Node or pnpm needed on the
host — with `/api/health` as the container healthcheck.
[SELF_HOSTING.md §4.7](SELF_HOSTING.md) states what that path deliberately does
not do (no TLS, no reverse proxy, no backups, and no worker process).

## Gates (all green at release; evidence/final-gates.log)

```bash
pnpm typecheck && pnpm lint        # tsc --noEmit, eslint (flat config)
pnpm test:unit                     # 602 tests (node --test + tsx)
pnpm test:integration              # 379 tests, resets welcome_test DB
pnpm test:e2e                      # 42 Playwright chromium tests on welcome_e2e DB (port 3111)
pnpm build                         # next build
pnpm scan:secrets                  # fails on secrets in tracked files (spec/ excluded)
pnpm audit:deps                    # pnpm audit --prod --audit-level high
pnpm drill:defect                  # injects a leak → gate must FAIL → revert → PASS (needs clean tree)
pnpm load:smoke                    # AC-53 local-only load numbers → evidence/load-smoke.json
node --test spec/tests/core.test.mjs   # archive's 24 core contract tests
```

## Deploy

> First deploy = **staging-test only**. Production permission is still false per
> the Phase 6 preflight — see [RELEASE_REPORT.md §6](RELEASE_REPORT.md).
>
> **Self-hosting your own instance?** Follow
> [SELF_HOSTING.md](SELF_HOSTING.md) instead: it covers any host (not just
> Vercel), your own credentials for every optional feature, and the two settings
> a clone must change — `LEGACY_REDIRECTS=off` (the shipped legacy redirects
> point at the *upstream author's* domain) and `OPERATOR_CONTACT_EMAIL` (the
> address your landing and legal pages publish). The steps below are the
> original deployment's own recipe, kept for the record.

Deploy (Vercel + managed EU Postgres):

1. **Managed Postgres (EU).** Create a Neon or Supabase database in an EU
   region; copy the connection string (`sslmode=require`).
2. **Env vars in the Vercel dashboard.** Set the names from
   [.env.deploy.example](.env.deploy.example): `APP_ENV=production`,
   `DATABASE_URL`, `ENCRYPTION_KEY` (base64 of 32 bytes), `HASH_PEPPER`,
   `APP_BASE_URL` (the deployment URL), `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`, `WORKER_TICK_SECRET`,
   and `CRON_SECRET` with the **same value** as `WORKER_TICK_SECRET` (Vercel
   Cron sends it as `Authorization: Bearer $CRON_SECRET`).
   `AUTH_DEV_EXPOSE_OTP` must stay unset.
3. **Migrate locally against the managed URL** (migrations are plain SQL,
   applied via postgres.js): `DATABASE_URL="postgres://…" pnpm db:migrate` — a
   shell-set `DATABASE_URL` overrides `.env.local`.
4. **Deploy** (push to `main` or `vercel deploy --prod`). `vercel.json` pins
   the function region to `fra1` (EU) and schedules the worker-tick cron
   (`17 3 * * *` — daily, which is the fastest the free plan allows).
5. **Verify.** `GET /api/health` must show `"status":"ok"` and `"db":"up"`;
   `"worker":"up"` requires a tick within the freshness window
   (`WORKER_FRESHNESS_SECONDS`, default `93600` = 26h: one daily cron period plus
   slack for cron dispatch jitter — see the note on the daily cron below). The
   same payload carries the outbox delivery lag — `"pending_jobs"` (non-terminal
   jobs: pending + leased) and `"oldest_pending_job_age_seconds"` (`null` when the
   queue is empty) — so a monitor can alert on a queue that stops draining, not
   only on a dead process — plus `"worker_last_tick_age_seconds"`: the age of the
   last real tick, or `null` when no tick was ever recorded. Prefer that number to
   the boolean when your alert threshold differs from this deployment's window:
   the age is the measurement, `worker` is only the verdict against the configured
   one.
   A build/deployment identity is published **only** when the operator asks for
   it (`HEALTH_EXPOSE_VERSION=true`, plus `APP_BUILD_ID`); by default the payload
   fingerprints nothing, and the migration version stays behind the worker secret.
   See `.env.example` and [SELF_HOSTING.md §4.8](SELF_HOSTING.md).

**Worker on serverless.** The long-running `pnpm worker` process is not
available on Vercel functions. Instead `POST|GET /api/internal/worker-tick`
runs exactly one outbox tick (batch 10) and returns `{processed: n}`. Auth is
one shared secret (`WORKER_TICK_SECRET`), compared constant-time, accepted as
the `x-worker-tick-secret` header or as `Authorization: Bearer <secret>`. Unset
secret → 401 in production (fail-closed).

**A daily cron is normal here, and it is not the delivery path.** Vercel's free
plan runs a cron at most once a day, which is why `vercel.json` ships
`17 3 * * *`; paid plans allow faster schedules, and the one-tick endpoint can
equally be pinged from anywhere else (this repo ships an optional 5-minute pinger
at `.github/workflows/worker-tick.yml`).
Messages do **not** wait for the cron: the Telegram webhook drains the outbox
inline after it has answered, so a reply goes out seconds after the user writes
to the bot (see `src/infra/post-response-tick.ts`). The cron is the backstop —
it keeps the queue draining on a deployment nobody is writing to, and keeps the
worker heartbeat alive. So if `/api/health` answers `"worker":"down"`, the fix is
**never** to delete the cron: set `WORKER_FRESHNESS_SECONDS` to your actual
cadence plus slack, and read `worker_last_tick_age_seconds` to see how old the
last tick really is.

**Telegram webhook.** Point the bot (setWebhook) at
`APP_BASE_URL + /api/webhooks/telegram` with `TELEGRAM_WEBHOOK_SECRET` set —
the route verifies the bot's `x-telegram-bot-api-secret-token` constant-time.

## Repo map

| Path | Contents |
|---|---|
| `src/app/` | Routes: `/me` (dashboard, contacts, events, intros, notes, privacy, telegram), `/p/:slug` public card, `/e/:slug` event, `/login`, `/claim/:token`, `/organizer`, `/api/*` |
| `src/domain/` | Pure business logic: matching, introductions, consent, campaigns, csv/import, events, vcard, profile |
| `src/infra/` | Outbox jobs, worker loop, Telegram handlers |
| `src/integrations/telegram/` | Transport selection (real/mock[dev]/disabled), webhook parsing |
| `src/lib/` | http (CSRF/errors), auth, crypto, db, env, ratelimit, public-profile |
| `src/i18n/` | en/ru/es dictionaries (fallback: en) |
| `db/migrations/` | SQL migrations 001–015, runner `scripts/migrate.mjs` (`schema_migrations`) |
| `scripts/` | Migrate, seed, worker, scan-secrets, defect-drill, load-smoke, validate-release-report |
| `tests/` | `unit/`, `integration/` (DB), `e2e/` (Playwright) |
| `evidence/` | Gates, drill, load smoke, screenshots, release report + index |
| `spec/` | **Protected baseline** — requirements, contracts, test plans. Do not modify |
| `reference-landing/` | **Protected** design reference only |
| `docs-internal/adr/` | Decision log (ADR-0001…0006) |
| `SELF_HOSTING.md` | Self-hosting guide: prerequisites, quickstart, your own bot/keys, custom domain, the Docker stack (§4.7), worker shutdown semantics (§4.8), what this repo is not |
| `Dockerfile`, `.dockerignore`, `docker-compose.yml` | Container path: multi-stage build (production dependencies only, non-root uid 1001), app + PostgreSQL + migration job. See SELF_HOSTING.md §4.7 |
| `.env.example` | Every env var the code reads, each labelled REQUIRED / OPTIONAL (gate: `tests/unit/env-example-coverage.test.ts`) |

## Handoff

- Release report (verdicts, blockers, honest acceptance mapping):
  [RELEASE_REPORT.md](RELEASE_REPORT.md) · machine: [evidence/release-report.json](evidence/release-report.json)
- Acceptance matrix (62 ACs): [evidence/ACCEPTANCE_STATUS.md](evidence/ACCEPTANCE_STATUS.md)
- Evidence index: [evidence/EVIDENCE_INDEX.md](evidence/EVIDENCE_INDEX.md)
- Environment record (executor, tools, honest limitations):
  [evidence/runtime/environment.md](evidence/runtime/environment.md)
- Decisions: [docs-internal/adr/](docs-internal/adr/) · CI definition: [.github/workflows/ci.yml](.github/workflows/ci.yml) (unverified on GitHub)

## What is deliberately NOT done

No contest submission (rules unresolved), no real-device QR / backup / rollback
rehearsals, and no Telegram round trip from a clean clone (it needs *your* bot
token and a public HTTPS URL — see [SELF_HOSTING.md §4.1](SELF_HOSTING.md)).
Exact blockers: [RELEASE_REPORT.md §6](RELEASE_REPORT.md).

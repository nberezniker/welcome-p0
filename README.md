# WELCOME

Persistent personal networking profile + reusable QR: one profile you control,
a public card you can print on a QR badge, event matching and consent-gated
contact exchange, with Telegram as the P0 messaging channel.

**Status:** `PASS_LOCAL` (Phase 6 of 6, 2026-09-07). Nothing was ever deployed —
no staging, no production, no real Telegram traffic. See
[RELEASE_REPORT.md](RELEASE_REPORT.md) and [evidence/](evidence/).

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

## Run locally

Requirements: Node ≥20.9 (built on 22.x), pnpm 10.x, PostgreSQL 16.

```bash
pnpm install
cp .env.example .env.local        # fill values; never commit .env.local
pnpm db:migrate                   # apply db/migrations (welcome_dev)
pnpm db:seed                      # optional: demo data (is_demo=true)
pnpm dev                          # http://localhost:3000
pnpm worker                       # outbox worker (separate terminal)
```

Env vars (`cp .env.example .env.local`, names only in git):

- Core: `APP_ENV` (`development`|`production`), `APP_BASE_URL`, `DATABASE_URL`,
  `AUTH_BASE_URL`, `ENCRYPTION_KEY` (base64 of 32 bytes), `HASH_PEPPER`, `LOG_LEVEL`
- Dev-only: `AUTH_DEV_EXPOSE_OTP=true` returns the OTP in the verify response
  when `APP_ENV=development`; otherwise codes go to `.runtime/otp.log` (gitignored)
- Channels (all optional; absent = disabled, never mocked in production):
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`,
  `LUMA_API_KEY`, `LUMA_WEBHOOK_SECRET`, `WHATSAPP_*`, `LINKEDIN_*`

## Gates (all green at release; evidence/final-gates.log)

```bash
pnpm typecheck && pnpm lint        # tsc --noEmit, eslint (flat config)
pnpm test:unit                     # 163 tests (node --test + tsx)
pnpm test:integration              # 166 tests, resets welcome_test DB
pnpm test:e2e                      # Playwright chromium smoke on welcome_e2e DB (port 3111)
pnpm build                         # next build (62 routes)
pnpm scan:secrets                  # fails on secrets in tracked files (spec/ excluded)
pnpm audit:deps                    # pnpm audit --prod --audit-level high
pnpm drill:defect                  # injects a leak → gate must FAIL → revert → PASS (needs clean tree)
pnpm load:smoke                    # AC-53 local-only load numbers → evidence/load-smoke.json
node --test spec/tests/core.test.mjs   # archive's 24 core contract tests
```

## Repo map

| Path | Contents |
|---|---|
| `src/app/` | Routes: `/me` (dashboard, contacts, events, intros, notes, privacy, telegram), `/p/:slug` public card, `/e/:slug` event, `/login`, `/claim/:token`, `/organizer`, `/api/*` |
| `src/domain/` | Pure business logic: matching, introductions, consent, campaigns, csv/import, events, vcard, profile |
| `src/infra/` | Outbox jobs, worker loop, Telegram handlers |
| `src/integrations/telegram/` | Transport selection (real/mock[dev]/disabled), webhook parsing |
| `src/lib/` | http (CSRF/errors), auth, crypto, db, env, ratelimit, public-profile |
| `src/i18n/` | en/ru/es dictionaries (fallback: en) |
| `db/migrations/` | SQL migrations 001–004, runner `scripts/migrate.mjs` (`schema_migrations`) |
| `scripts/` | Migrate, seed, worker, scan-secrets, defect-drill, load-smoke, validate-release-report |
| `tests/` | `unit/`, `integration/` (DB), `e2e/` (Playwright) |
| `evidence/` | Gates, drill, load smoke, screenshots, release report + index |
| `spec/` | **Protected baseline** — requirements, contracts, test plans. Do not modify |
| `reference-landing/` | **Protected** design reference only |
| `docs-internal/adr/` | Decision log (ADR-0001…0006) |

## Handoff

- Release report (verdicts, blockers, honest acceptance mapping):
  [RELEASE_REPORT.md](RELEASE_REPORT.md) · machine: [evidence/release-report.json](evidence/release-report.json)
- Acceptance matrix (62 ACs): [evidence/ACCEPTANCE_STATUS.md](evidence/ACCEPTANCE_STATUS.md)
- Evidence index: [evidence/EVIDENCE_INDEX.md](evidence/EVIDENCE_INDEX.md)
- Environment record (executor, tools, honest limitations):
  [evidence/runtime/environment.md](evidence/runtime/environment.md)
- Decisions: [docs-internal/adr/](docs-internal/adr/) · CI definition: [.github/workflows/ci.yml](.github/workflows/ci.yml) (unverified on GitHub)

## What is deliberately NOT done

No staging/production deploy (no host/credentials; production permission false),
no real Telegram round trip (no bot token/public webhook URL), no contest
submission (rules unresolved), no real-device QR / backup / rollback rehearsals.
Exact blockers: [RELEASE_REPORT.md §6](RELEASE_REPORT.md).

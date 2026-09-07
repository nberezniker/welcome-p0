# WELCOME P0 — Phase 1

Persistent personal networking profile + reusable QR product. This phase covers the
foundation: identity (email OTP), profile with public card, vCard, QR, and health.

Protected baselines (do not modify): `spec/` — requirements; `reference-landing/` — design reference only.

## Stack

- Next.js (App Router) + TypeScript strict, Tailwind CSS v4
- PostgreSQL 16 via `postgres` (postgres.js) — **no ORM**
- SQL migrations in `db/migrations/`, runner in `scripts/migrate.mjs` (`schema_migrations`)

## Setup

```bash
pnpm install
cp .env.example .env.local            # fill values; never commit .env.local
pnpm db:migrate                       # apply migrations (welcome_dev by default)
pnpm db:seed                          # optional: 2 demo profiles (is_demo=true)
pnpm dev                              # http://localhost:3000
```

Required env: `DATABASE_URL`, `HASH_PEPPER`, `ENCRYPTION_KEY` (base64 of 32 bytes),
`APP_BASE_URL`, `APP_ENV`. Dev-only: `AUTH_DEV_EXPOSE_OTP=true` exposes the OTP in
the verify response when `APP_ENV=development`; otherwise codes land in
`.runtime/otp.log` (gitignored).

## Gates

```bash
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint flat config
pnpm test:unit          # node --test (tsx loader), tests/unit/
pnpm test:integration   # resets + migrates welcome_test, runs tests/integration/
pnpm build
pnpm scan:secrets       # fails on obvious secrets in tracked files (spec/ excluded)
pnpm audit:deps         # pnpm audit --prod --audit-level high
pnpm db:reset           # DEV ONLY: drop schema + re-apply migrations (refuses production)
pnpm drill:defect       # controlled defect drill: inject leak -> gate FAIL -> revert -> PASS (needs clean tree)
pnpm load:smoke         # AC-53 load smoke, LOCAL-ONLY indicative numbers -> evidence/load-smoke.json
```

## Security hardening (Phase 5)

- CSRF: every mutating handler is exported through `withApi` (src/lib/http.ts) —
  cross-origin POST/PATCH/PUT/DELETE → `403 csrf_origin`; no-Origin requests
  pass unless `Sec-Fetch-Site: cross-site` (curl/webhooks keep working).
- Rate limits: in-memory per-IP token buckets (ADR 0005) — OTP 10/min,
  registration-claims/reports/blocks 30/min; `X-RateLimit-*` headers; 429
  `retryable:true`. DB-level per-subject throttles remain in force.
- `GET /api/organizer/events/:eventId/export` — event-scoped CSV, owner/admin,
  formula-neutralized cells, no emails/hashes/pair identities.

## API (Phase 1)

| Endpoint | Notes |
|---|---|
| `POST /api/auth/otp/request` | `{email}` → always `{ok:true}` (enumeration-safe); 3 codes / 15 min |
| `POST /api/auth/otp/verify` | `{email, code}` → session cookie `welcome_session`; 5 attempts per OTP |
| `POST /api/auth/logout` | destroys session server-side |
| `GET/POST /api/me/profile` | own profile; updates require `revision`, stale → `409` |
| `GET/PUT /api/me/contacts` | kind+value, AES-256-GCM encrypted at rest, `public_enabled` |
| `GET /api/public/profiles/:slug` | public projection only |
| `GET /api/public/profiles/:slug/vcard` | vCard 3.0, public fields only |
| `GET /api/public/profiles/:slug/qr.svg` | QR of `APP_BASE_URL/p/:slug` |
| `GET /api/health` | DB read+write, migrations, worker heartbeat freshness |
| `GET /api/organizer/events/:eventId/export` | owner/admin event CSV export (Phase 5): registrations + directory members + intro aggregates, formula-neutralized |

Errors: `{code, message, correlation_id, retryable}` — never SQL/stacks/secrets.

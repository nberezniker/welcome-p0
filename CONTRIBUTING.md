# Contributing

## Ground rules (non-negotiable, from `spec/`)

1. **Deterministic matching core.** `src/domain/matching.ts` must stay in
   parity with `spec/contracts/matching.mjs` — parity tests fail otherwise.
2. **Consent is never implicit.** No UI click or language change may grant a
   purpose. Every purpose-scoped grant lives in `consent_events` (append-only).
3. **Server-side authorization everywhere.** Never trust actor/org ids from
   request bodies. Cross-tenant negative tests are part of the suite.
4. **No silent mocks.** Optional integrations (WhatsApp/LinkedIn/Luma/Telegram)
   are either live or visibly disabled — never mocked in production builds.

## Workflow

- `pnpm i`, copy `.env.example` → `.env.local`, point `DATABASE_URL` at a local
  Postgres, then `pnpm db:migrate`.
- Before pushing: `pnpm typecheck && pnpm lint && pnpm test:unit &&
  pnpm test:integration && pnpm build && pnpm scan:secrets`.
- Integration tests need `welcome_test` database (`DATABASE_URL` env).
- Keep `spec/` untouched — it is the product contract the code is audited
  against. Propose spec changes in a separate PR/discussion first.

## Release discipline

`RELEASE_REPORT.md` follows `spec/contracts/release-report.schema.json` with
honest statuses (`PASS_LOCAL` / `BLOCKED_EXTERNAL` / …). Do not claim staging
or production readiness without a deployed, health-verified environment.

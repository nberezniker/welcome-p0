# Deployment options and recommended P0

## Recommended P0
**Vercel web/API + managed PostgreSQL/Auth (Supabase) + one scheduled outbox processor** is a practical low-ops path if the selected plans support required cron/runtime and an EU DB region is deliberately chosen. If scheduled execution limits become a problem, run the worker as a separate small Node service (e.g. Railway) against the same DB.

The archive does not create these resources or assume a specific plan.

## Why not Sheets/Airtable core
Mutual consent, single-use challenges, idempotent webhook handling, cross-tenant authorization and concurrent introductions require transactional constraints. CSV remains an interchange format, not the authorization database.

## Immutable release contract
Build artifact records commit SHA, dependency lock digest, migration version and frontend/worker version. Staging uses the exact artifact intended for production. Production deployment does not rebuild from a different dependency state.

## Environments
- local: mocks allowed, obvious `DEMO` badge;
- staging: separate DB/bot IDs, real Telegram, synthetic users only;
- production: no seeded demo accounts in normal directory; provider mocks compile-time/runtime disabled; separate secrets.

## Deployment adapter must provide
`build`, `migrate_dry_run`, `deploy_staging`, `smoke_staging`, `rollback_rehearsal`, `deploy_production`, `health_production`, `rollback_production`, and a way to show exact deployed SHA.

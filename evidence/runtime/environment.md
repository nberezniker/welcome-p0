# Runtime environment record — Phase 6 (final)

Recorded: 2026-09-07 23:47 CEST (+0200), timezone **Europe/Madrid**.
This file states the environment that produced every gate result and evidence
artifact in `evidence/`. Nothing is extrapolated: only tools that were actually
used are listed.

## Host

- macOS 26.6.2 (Darwin 25.6.0), **arm64**, local workstation (`MacBook-Pro-mac`).
- No cloud/CI runner was used for verification; the GitHub Actions CI definition
  (`.github/workflows/ci.yml`) exists but has not been observed running on GitHub.

## Toolchain (actual versions, verified with `--version` at record time)

| Tool | Version | Notes |
|---|---|---|
| Node.js | v22.22.3 | test runner (`node --test`), Next.js runtime |
| pnpm | 10.29.3 | package manager, script runner |
| PostgreSQL | 16.13 (Homebrew) | local instance on localhost:5432, `pg_isready` → accepting connections |
| git | 2.50.1 (Apple Git-155) | local repository only — **no remote push has been performed** |
| Playwright | @playwright/test 1.63.x | **local chromium** (ms-playwright cache: chromium-1243 + chromium_headless_shell) — used for e2e smoke and all screenshots |
| TypeScript | 5.9.2 | via devDependencies (`pnpm exec tsc --noEmit`) |
| Next.js | 15.5.4 | via dependencies |

## Executor (stated plainly)

- The executor was an **OpenClaw/AutoClaw session running the bundled ZCode CLI
  agent** (terminal-based coding agent). All work — code, tests, gates,
  evidence capture — was done through that agent with shell/file tools.
- **No undocumented AutoClaw CLI or machine-level API was used or assumed.**
- **The AutoClaw native browser preview was NOT used for verification.**
  Browser verification (e2e smoke, screenshots, UI checks) used **Playwright
  chromium locally** instead.

## Databases (local PostgreSQL 16.13)

- `welcome_dev` — dev DB; `schema_migrations` shows 001, 002, 003, 004 applied
  (highest applied migration: **004** `004_outbox_campaigns.sql`).
- `welcome_test` — reset + migrated by `pnpm test:integration` on every run.
- `welcome_e2e` — reset + migrated by the Playwright global setup on every run.

## Environment variables actually present in `.env.local` (names only, never values)

`APP_ENV`, `APP_BASE_URL`, `DATABASE_URL`, `AUTH_BASE_URL`, `ENCRYPTION_KEY`,
`HASH_PEPPER`, `LOG_LEVEL`, `AUTH_DEV_EXPOSE_OTP`.

Notably **absent** (relevant to integration status): `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET` values usable for a live bot, `LUMA_API_KEY`,
WhatsApp (`WHATSAPP_*`), LinkedIn (`LINKEDIN_*`). Telegram transport runs with
the mock transport (unit-tested, gated by `APP_ENV`) and disabled-transport
fallback — no real bot was contacted.

## Repository state at the final gate run

- HEAD: `7605b005bc90f77b90d82a561a0b6e6bdcbe1f34` (branch `main`) — this is the
  commit "fix(drill): residue check tolerates the drill's own evidence outputs".
- `git rev-parse HEAD` → `7605b005bc90f77b90d82a561a0b6e6bdcbe1f34`
- `git status --porcelain` at gate-run start → **empty** (clean; enforced by
  `drill:defect`, which refuses a dirty worktree).
- Gate outputs were staged in `/tmp` during the run (not in the repo) so the
  drill's clean-tree precondition held; the combined log was copied to
  `evidence/final-gates.log` afterwards. The final Phase-6 commit adds exactly
  these evidence/report files on top of the gate-verified tree.

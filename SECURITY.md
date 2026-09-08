# Security Policy

WELCOME handles personal data: public networking profiles, contact fields
(encrypted at rest), consent records and introductions. Treat security issues
seriously.

## Reporting a vulnerability

- Do **not** open a public GitHub issue for security problems.
- Email **nberezniker@gmail.com** with the subject `[welcome-p0 security]`.
- Include reproduction steps, affected endpoint/commit SHA and impact estimate.
- You will get an acknowledgment within 72 hours.

## Scope notes

- The live demo at `welcome-p0-*.vercel.app` is a **staging-test** deployment
  with `is_demo` synthetic data only. Production release permission is
  intentionally `false` per `spec/autoclaw/preflight-v3.json`.
- Never deploy without setting fresh `ENCRYPTION_KEY` / `HASH_PEPPER`
  (32-byte base64 each) and a strong `WORKER_TICK_SECRET`.
- Telegram adapter ships **disabled** without `TELEGRAM_BOT_TOKEN` — there is
  no silent mock fallback in production builds (enforced by tests).

## Known limitations (by design, P0)

- In-memory rate limiter (single process) — see `docs-internal/adr/0005-*`.
- Serverless deployments drive the outbox via `/api/internal/worker-tick`
  (secret-protected) or the `pnpm worker` long-running process.

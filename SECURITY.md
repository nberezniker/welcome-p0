# Security Policy

WELCOME handles personal data: public networking profiles, contact fields
(encrypted at rest), consent records and introductions. Treat security issues
seriously.

## Reporting a vulnerability

- Do **not** open a public GitHub issue for security problems.
- Use the private reporting channel configured for the deployment you are testing
  (`OPERATOR_CONTACT_EMAIL`, subject `[welcome-p0 security]`); if you cloned this
  repository and run your own instance, that address is yours to set — see
  [SELF_HOSTING.md](SELF_HOSTING.md) § Operator contact.
- Include reproduction steps, affected endpoint/commit SHA and impact estimate.

## Scope notes

- The live demo at `welcome.colmogravity.net` (formerly `welcome-p0-*.vercel.app`)
  is a **staging-test** deployment with `is_demo` synthetic data only, operated by
  the upstream author. Production release permission is intentionally `false` per
  `spec/autoclaw/preflight-v3.json`.
- Never deploy without setting fresh `ENCRYPTION_KEY` / `HASH_PEPPER`
  (32-byte base64 each) and a strong `WORKER_TICK_SECRET`.
- Telegram adapter ships **disabled** without `TELEGRAM_BOT_TOKEN` — there is
  no silent mock fallback in production builds (enforced by tests).

## Secrets in tracked files

`pnpm scan:secrets` is a release gate and a CI step: it scans every tracked file
for credential-shaped strings and fails the build on a hit. A test fixture
occasionally has to *look* like a credential — a parser test needs a value shaped
like a Google access token. For those, the scanner accepts a per-line exemption
written as a comment on the same line. This very paragraph carries one, so the
mechanism is visible in the output of every scan:

```
const ACCESS_TOKEN = 'ya29.synthetic'; // secret-scan:allow invented parser fixture, never sent anywhere
```

The reason is mandatory (≥ 12 characters), every exemption is printed on **every**
run, a marker with a missing or too-short reason exempts nothing (the line stays
a hit), and a marker that matches nothing is reported as stale.
`tests/unit/scan-secrets-exemptions.test.ts` proves both halves end to end,
against a throwaway git repository. Full rationale:
[SELF_HOSTING.md §6](SELF_HOSTING.md).

If a real credential reaches this repository, **rotate it first** — rewriting
history does not un-leak it.

## Known limitations (by design, P0)

- In-memory rate limiter (single process) — see `docs-internal/adr/0005-*`.
- Serverless deployments drive the outbox via `/api/internal/worker-tick`
  (secret-protected) or the `pnpm worker` long-running process.

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
- **`ENCRYPTION_KEY` is rotatable — with a keyring, and by that route only.** One
  AES-256-GCM key encrypts every value at rest that has a key: contact values, the
  emails imported from a registration CSV, the TOTP shared secret, the OAuth PKCE
  code verifier, and Google grant access / refresh tokens (the six columns are
  `ENCRYPTED_COLUMNS` in `src/domain/key-rotation.ts`, checked against the schema
  by `tests/integration/encrypted-columns.test.ts`). Each payload names the key id
  that sealed it in the slot that used to be a hard-coded `v1`
  (`<key-id>.<iv>.<ciphertext>.<tag>`, `src/lib/crypto.ts`), so a deployment can
  hold several keys at once: exactly one ACTIVE (what new writes use) and any
  number still readable. `ENCRYPTION_KEY` remains the ACTIVE key and its id
  remains `v1` unless `ENCRYPTION_KEY_ID` says otherwise — a deployment that sets
  neither of the rotation variables behaves exactly as it always has, and the
  payloads it writes are byte-for-byte what it wrote before. Rotating is then
  ordinary states rather than one atomic act: add the new key, flip the active id,
  run `pnpm key:rotate` until its dry run reads zero rows on the old key, then
  retire it — the order, the verification counts and the rollback are in
  [docs-internal/ops/RUNBOOK.md §5](docs-internal/ops/RUNBOOK.md). Two limits
  remain honest: a payload whose key is **not** in the keyring is unreadable until
  the key is restored (the error names the id — there is no fallback to the active
  key), and the OAuth `state` MAC still derives from `ENCRYPTION_KEY` **alone**,
  so flipping that variable invalidates states issued in the previous ten minutes.
  Moving it is a decision with that window attached, deliberately not taken yet —
  [docs-internal/security/KEY_ROTATION_ASSESSMENT.md](docs-internal/security/KEY_ROTATION_ASSESSMENT.md)
  states both options, the six ciphertext columns, the expand → flip → backfill →
  contract order for a live deployment and the risks.
  (The single-operator note for self-hosters is in
  [SELF_HOSTING.md §3.3](SELF_HOSTING.md).)

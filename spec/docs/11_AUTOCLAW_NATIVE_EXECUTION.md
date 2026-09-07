# AutoClaw-native execution contract

## Why v3 changes the execution model
The previous pack correctly refused to pretend that the current ColmoCode `agy` maker was AutoClaw, but it underused current AutoClaw capabilities. Official current material explicitly presents web product building, browser automation, long-PRD Auto Design and Cluster Mode auditing. Use AutoClaw as the primary implementer; use repository-local tests and independent reviews as external evidence gates.

## Role map for Cluster Mode
- **Lead / Architect:** reads PRD, architecture, acceptance matrix; creates implementation plan and ADRs. No code until plan and data boundaries are explicit.
- **Backend implementer:** schema, auth, RLS/application authorization, imports, matching, introductions, outbox.
- **Frontend implementer:** public card, account/profile, event flows, organizer dashboard, i18n/accessibility.
- **Integration implementer:** Telegram P0, Luma CSV; optional Luma API/LinkedIn/WhatsApp only when preflight passes.
- **QA:** unit/integration/e2e/browser/negative fixtures; never edits acceptance criteria to make code pass.
- **Security/privacy reviewer:** tenancy, tokens, webhooks, consent, logs, exports, QR abuse, secret scan.
- **Release auditor:** immutable SHA/artifact, staging evidence, rollback rehearsal, production promotion.

If AutoClaw chooses fewer/more roles, these responsibilities still must be covered in evidence.

## Hard execution rules
1. One Git repository / clean worktree. Existing user repos are read-only reuse sources unless owner explicitly chose a target.
2. Build tests/gates before feature implementation. Gate definitions, acceptance matrix and release policy are protected from implementation agents.
3. No invented AutoClaw CLI/API. Use capabilities actually exposed by installed AutoClaw; document them in `evidence/IMPLEMENTATION_ENVIRONMENT.md`.
4. No automatic model fallback. If a model/quota is unavailable, record `BLOCKED_PROVIDER` or require owner-selected alternative.
5. Maximum three identical failure fingerprints before a repair diagnosis; no infinite retry.
6. Optional integration absent => visibly disabled + passing disabled-state tests, not mock “success”.
7. Final reviewer receives exact diff/commit SHA + acceptance criteria + test logs. Review parser rejects empty/contradictory result.
8. Production permission is separate from implementation permission. Never deploy every task individually.
9. Staging comes first. Real QR, real Telegram round trip, revoke/delete and two-tenant negative tests must run against staging.
10. Production promotion uses the same reviewed immutable artifact. Health failure triggers rollback and final status remains FAIL.

## Evidence directory to create during implementation
```text
evidence/runtime/
  environment.md
  plan.md
  test-unit.log
  test-integration.log
  test-e2e.log
  browser/
  security.log
  rls-negative.log
  telegram-roundtrip.json
  luma-import.json
  build.json
  review.md
  staging-release.json
  rollback-rehearsal.json
  production-release.json   # only if authorized
  RELEASE_REPORT.md
```
Never put secret values, raw access tokens, private message bodies or unredacted exports in evidence.

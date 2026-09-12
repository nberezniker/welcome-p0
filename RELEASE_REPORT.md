# WELCOME P0 — Release Report (Phase 6 of 6)

- **Date:** 2026-09-07 (Europe/Madrid)
- **Overall status: `PASS_LOCAL`** — all verification ran on a local workstation. **Nothing was deployed.** No `PASS_STAGING` / `PASS_PRODUCTION` claim exists anywhere in this report.
- **Machine report:** [evidence/release-report.json](evidence/release-report.json) — validated against `spec/contracts/release-report.schema.json` by `scripts/validate-release-report.mjs` (hand-rolled, no new deps) → **exit 0** ([evidence/release-report-validation.txt](evidence/release-report-validation.txt)).
- **Commit:** `7605b005bc90f77b90d82a561a0b6e6bdcbe1f34` (branch `main`) — the tree that passed the final full gate run (`drill:defect` enforces a clean worktree). The final Phase-6 commit adds only evidence/report files on top of this tree; a file cannot contain the SHA of the commit that first contains it.
- **Spend: 0 EUR.** No paid resources were created (no domains, hosting, managed DBs, API plans, contest submissions).

## 1. Scope verdicts

| Scope | Status | Basis |
|---|---|---|
| Identity / profile / QR | `PASS_LOCAL` | OTP auth (enumeration-safe), opaque 22-char slug, public projection only, vCard escaping, QR payload, rotate/revoke — unit + integration + e2e |
| Events / import / claim | `PASS_LOCAL` | CSV preview/commit safety, idempotent re-import, no implicit account creation, claim anti-abuse (AC-07/08/09/17/18/19), quarantine |
| Matching / introductions | `PASS_LOCAL` | Deterministic matching core, consent-gated reveal, idempotent intros, withdrawal suppression, notes owner-only |
| Organizer / campaigns | `PASS_LOCAL` | Cross-tenant 404/403 anti-enumeration, purpose registry, approval-reset-on-edit, audience revalidation, test-send, unsubscribe suppression |
| Telegram | `PASS_LOCAL` (mock + disabled transports) — live round trip `BLOCKED_EXTERNAL` | Webhook secret fail-closed, deep-link binding (web confirm + /start), update_id dedupe, /stop & block suppression. **No real message was ever sent.** |
| Privacy / security | `PASS_LOCAL` | CSRF origin guard, rate limits, IDOR negative suite, XSS / CSV-formula / webhook-replay tests, secret scan, dependency audit, 1 review finding fixed |
| Quality / ops | `PASS_LOCAL` | EN/RU/ES dictionaries, 360/1440 overflow check + screenshots, e2e smoke, defect drill, load smoke (local-only indicative) |
| WhatsApp Business | `BLOCKED_EXTERNAL` | Disabled by design, disabled state visible; no credentials; `wa.me` not counted as API |
| LinkedIn OIDC | `BLOCKED_EXTERNAL` | Disabled; no credentials; no scraping fallback exists (verified in review) |
| Luma API | `BLOCKED_EXTERNAL` | Disabled; no credentials; CSV import P0 works fully |
| Staging deploy | `BLOCKED_EXTERNAL` | No public HTTPS host / managed Postgres credentials; `release_permission.staging` preflight requires exactly those absent external inputs |
| Production | `BLOCKED` | `release_permission.production=false` (production preflight, spec/WELCOME_TZ_v3.md §4); nothing deployed |
| Contest | `BLOCKED_CONTEST_RULES` | Official rules/form URLs unresolved per spec/docs/08_CONTEST.md; no submission made |

## 2. Final full gate run (fresh, sequential, all exit 0)

Full raw log: [evidence/final-gates.log](evidence/final-gates.log) · machine summary: [evidence/final-gates.json](evidence/final-gates.json).

| # | Command | Exit | Counts |
|---|---|---|---|
| 1 | `pnpm typecheck` | 0 | 0 errors |
| 2 | `pnpm lint` | 0 | 0 errors, 2 warnings (pre-existing, unused vars) |
| 3 | `pnpm test:unit` | 0 | **163 pass / 0 fail** |
| 4 | `pnpm test:integration` | 0 | **166 pass / 0 fail** |
| 5 | `pnpm test:e2e` | 0 | **1 pass / 0 fail** (chromium, self-hosted dev server + `welcome_e2e` DB) |
| 6 | `pnpm build` | 0 | Compiled, 26/26 static pages, **62 routes** |
| 7 | `pnpm scan:secrets` | 0 | 0 findings in tracked files |
| 8 | `pnpm audit:deps` | 0 | No known vulnerabilities (prod deps, ≥high threshold) |
| 9 | `pnpm drill:defect` | 0 | Injected leak → gate FAIL (exit 1) → revert → PASS (exit 0), no residue |
| 10 | `node --test spec/tests/core.test.mjs` | 0 | **24 pass / 0 fail** (archive core contracts, untouched spec) |

## 3. Build & migration digest

| Item | Value |
|---|---|
| `.next/BUILD_ID` | `V3stXnonSN2R1Kyv2bvmt6d9b` |
| sha256(`.next/BUILD_ID`) | `d924fb92ba4b0ae76862130d29ad0bd6b18eebd1dfd7ac56d8308eabd1a` |
| Routes (build output) | 62 |
| Static pages | 26/26 |
| Migration version (`welcome_dev`, local PG 16.13) | **004** (`001`–`004` applied, query of `schema_migrations`) |

## 4. Security summary

- **Findings: 1 found, 1 fixed.** Blocks did not freeze introductions (a blocked party could still create/receive intro requests). Fixed in `ad518f4` (*fix(intro): blocks freeze introductions — SECURITY_TESTS #11*); regression tests assert 403 + symmetric freeze.
- **Defect drill evidence:** [evidence/DEFECT_DRILL.md](evidence/DEFECT_DRILL.md), [defect-drill-fail.log](evidence/defect-drill-fail.log), [defect-drill-pass.log](evidence/defect-drill-pass.log) — the public-projection gate demonstrably FAILS on an injected leak and PASSES after revert.
- Secret scan + `pnpm audit --prod --audit-level high` green; logs/evidence inspected for PII/secrets (OTP log gitignored under `.runtime/`).

## 5. Release-acceptance mapping

Every checkbox of `spec/tests/PRODUCTION_ACCEPTANCE.md`, mapped honestly. **Nothing is checked that was not actually verified.**

| Checkbox | Status | Evidence / note |
|---|---|---|
| Auth flow verified, enumeration-safe | `PASS_LOCAL` | otp unit + integration tests (identical bodies for unknown/wrong), final-gates.log |
| Public slug opaque/random; card works without account | `PASS_LOCAL` | slug unit tests (16 random bytes, 22 chars base64url), e2e public card |
| Only public fields in public API/HTML/hydration/cache | `PASS_LOCAL` | integration "public API returns ONLY the public projection" — the exact test the defect drill targets |
| vCard public fields only, correct escaping | `PASS_LOCAL` | escapeVCard unit + core tests, integration vcard |
| QR decodes to exact HTTPS URL on iOS/Android/in-app | `BLOCKED_EXTERNAL` | Payload correctness `PASS_LOCAL` (QR SVG unit test, e2e); real-device scan (AC-55) impossible locally |
| Rotate/revoke public field, cache updates | `PASS_LOCAL` | integration public-profile revision/cache tests |
| CSV preview+commit; malformed/oversized/formula safe | `PASS_LOCAL` | csv unit + import integration (413 oversize, formula→data) |
| Re-import idempotent | `PASS_LOCAL` | integration AC-17 |
| Import alone creates no account | `PASS_LOCAL` | integration "import creates NO accounts and NO profiles" |
| Forwarded/expired claim cannot bind another user | `PASS_LOCAL` | integration AC-07/08/09 (403 email_mismatch, 409 replay, 410 expired) |
| Unknown status → quarantine | `PASS_LOCAL` | normalizeApprovalStatus fail-closed tests |
| no-self / blocks / eligibility / stable order | `PASS_LOCAL` | core tests 24/24 + matching integration |
| reason uses only real shared fields | `PASS_LOCAL` | "fact-based reasons only", parity tests vs spec core |
| intro creation idempotent | `PASS_LOCAL` | integration canonical pair/idempotency |
| A/B independent; reveal only after mutual + consent | `PASS_LOCAL` | AC-31/32/34 integration + canRevealPrivate contract |
| Consent withdrawal before send/reveal suppresses | `PASS_LOCAL` | AC-25 integration, outbox suppression |
| Private note visible only to owner | `PASS_LOCAL` | AC-35 integration (organizer excluded too) |
| Two organizers cannot access each other's events | `PASS_LOCAL` | AC-22 integration (403/404 anti-enumeration) |
| Organizer cannot read global network/private notes | `PASS_LOCAL` | AC-35 + export scoping tests |
| staff/admin/owner differ, tested server-side | `PASS_LOCAL` | AC-23, requireEventRole tests |
| Analytics aggregate/event-scoped, demo excluded | `PASS_LOCAL` | campaign stats tests (aggregates, is_demo excluded) |
| Campaign purpose/preview/test-send/approval/launch/unsubscribe | `PASS_LOCAL` | campaigns integration suite (AC-40 reset included) |
| Real HTTPS webhook + secret validation | `BLOCKED_EXTERNAL` | Secret validation logic `PASS_LOCAL` (401 fail-closed tests via local HTTP); no public HTTPS endpoint exists |
| Deep-link one-time challenge binds correct account | `PASS_LOCAL` | AC-11 integration (stolen challenge → 404, binding needs web confirm + /start) |
| `/start` is not consent | `PASS_LOCAL` | "join/`/start` create ZERO consent rows" tests |
| Real inbound+outbound round trip on staging | `BLOCKED_EXTERNAL` | AC-38 — no bot token, no public URL, no staging |
| block/stop/unlink prevents subsequent messages | `PASS_LOCAL` | AC-39 integration + transport matrix — **against mock/disabled transports only** |
| Purpose-scoped consent, no implicit consent | `PASS_LOCAL` | consent purpose unit + integration (join ≠ marketing opt-in) |
| Export and delete flow exercised; consequences verified | `PASS_LOCAL` | export integration (no PII, formula-neutralized); delete → public 404 tested. **Gap honestly noted:** pending-job cancellation on deletion has no automated test |
| IDOR/cross-tenant negative suite green | `PASS_LOCAL` | anti-enumeration + authz integration suites |
| XSS/CSRF/rate-limit/CSV-formula/webhook-replay green | `PASS_LOCAL` | stored-XSS, CSRF origin-guard, token-bucket, neutralizeCsvCell, replay-hardening tests |
| Secret scan + dependency/security review, no open high/critical | `PASS_LOCAL` | gate 7/8 exit 0; security review done (1 finding fixed) |
| Logs/evidence inspected for PII/secrets | `PASS_LOCAL` | scan:secrets 0 findings; OTP codes land in gitignored `.runtime/otp.log`; evidence contains demo data only |
| EN/RU/ES core flows; mobile widths; a11y baseline | `PASS_LOCAL` | dictionaries unit (ru/es cover en keys); e2e 360px overflow check; screenshots 360/1440 EN/RU. **Not covered:** 390/768 screenshots, no automated a11y run, ES exercised at unit level only |
| unit + integration + DB auth + E2E + browser green | `PASS_LOCAL` | this gate run (§2) |
| Controlled defect causes gates to fail | `PASS_LOCAL` | drill evidence (§4) |
| Staging health includes DB/worker/migration | `BLOCKED_EXTERNAL` | `/api/health` implements DB read+write + migration version + worker heartbeat; but **no staging exists** to health-check |
| Backup restore + rollback rehearsal recorded | `NOT RUN` | AC-54/AC-57 — requires staging; none exists |
| Immutable reviewed SHA promoted; no rebuild drift | `NOT RUN` | no promotion was ever performed |
| Mocks/seeded demo disabled/excluded in production | `PASS_LOCAL` | transport-matrix unit tests ("production with TELEGRAM_MOCK=1 → STILL disabled"), is_demo exclusion, db:seed/db:reset refuse production |
| Luma API live-verified or visibly disabled; CSV P0 works | `BLOCKED_EXTERNAL` | disabled (no key); CSV P0 fully tested |
| LinkedIn OIDC live or disabled; no scraping | `BLOCKED_EXTERNAL` | disabled; no scraping fallback exists |
| WhatsApp live with evidence or disabled; `wa.me` not counted | `BLOCKED_EXTERNAL` | disabled by design, visible; no policy/template/webhook evidence |
| RELEASE_REPORT validates against schema | `PASS_LOCAL` | validator exit 0 (§ header) |
| Exact URLs/SHA/tests/integrations/blockers/spend/unverified listed | `PASS_LOCAL` | this report + release-report.json (staging/production URLs explicitly `null`) |

## 6. Blockers (exact)

1. `TELEGRAM_BOT_TOKEN` + public HTTPS webhook URL absent → real Telegram round trip (AC-38) `BLOCKED_EXTERNAL`.
2. No staging HTTPS host / managed Postgres credentials → staging deploy `BLOCKED_EXTERNAL`; backup restore (AC-54) and rollback (AC-57) `NOT RUN`.
3. `release_permission.production=false` (preflight-v3 semantics, spec/WELCOME_TZ_v3.md §4) → production `BLOCKED`.
4. Contest rules/form URLs unresolved → contest `BLOCKED_CONTEST_RULES` (AC-61).
5. No physical phone in the loop → real-device QR check (AC-55) `BLOCKED_EXTERNAL`.

Full list with per-integration detail: [evidence/release-report.json](evidence/release-report.json) → `blockers[]`, `unverified_items[]`.

## 7. Statements

- **Mock-in-production:** the Telegram mock transport is gated by `APP_ENV` and unit-tested to never select mock in production (`selectTransport: production with TELEGRAM_MOCK=1 → STILL disabled`; production without token → disabled, never a silent drop). In production the disabled-transport fallback suppresses outbox jobs (`no_channel` / transport disabled) rather than dropping them silently. Demo seed data is flagged `is_demo=true`, excluded from analytics/directory; `db:seed` / `db:reset` refuse to run in production.
- **Spend/limits:** 0 EUR, no paid resources created, no external services contacted for verification (no real Telegram/Luma/WhatsApp/LinkedIn traffic).

## 8. Deviations & method notes (explicit)

1. **Drill residue-check fix (this phase):** `pnpm drill:defect` initially exited 1 — its residue check demanded an empty `git status --porcelain` while the drill itself rewrites its tracked evidence logs (they embed the commit SHA and test durations), which is unsatisfiable on any re-run. Fixed in `7605b00`: residue = tracked modification *outside the drill's own three evidence outputs*. The drill's protective property (inject→FAIL→revert→PASS) was unaffected and is re-proven in the final run.
2. **Gate logs staged in `/tmp`** during the run because the drill refuses a dirty worktree; the combined log was copied to `evidence/final-gates.log` immediately after the run finished.
3. **Self-reference:** `commit_sha` refers to the gate-verified tree; the final commit containing this report necessarily has a different (newer) SHA.
4. **Executor/environment:** OpenClaw/AutoClaw session with the bundled ZCode CLI agent; no undocumented AutoClaw CLI or machine API used or assumed; AutoClaw native browser preview NOT used — Playwright chromium locally was used for all browser verification. Details: [evidence/runtime/environment.md](evidence/runtime/environment.md).
5. **CI unverified:** `.github/workflows/ci.yml` is defined but was never observed running on GitHub (no remote push was performed).

## 9. Handoff pointers

- Acceptance matrix (62 ACs, honest per-AC status): [evidence/ACCEPTANCE_STATUS.md](evidence/ACCEPTANCE_STATUS.md)
- Evidence index: [evidence/EVIDENCE_INDEX.md](evidence/EVIDENCE_INDEX.md)
- Environment record: [evidence/runtime/environment.md](evidence/runtime/environment.md)
- Product handoff & how to run: [README.md](README.md) · Decision log: [docs-internal/adr/](docs-internal/adr/)

---

## Live update — 2026-09-08 evening (staging-test deployed)

Post-report deployment executed with the owner present (zero spend):

- **Managed DB:** Neon Free, region **Frankfurt (aws-eu-central-1)** — `holy-queen-11447908`, migrations 001–004 applied, 26 tables.
- **Live URL:** https://welcome-p0-nikiti4.vercel.app — `GET /api/health` → `{"status":"ok","db":"up","migrations":"applied","migration_version":"004","worker":"up"}`.
- **Verified live:** landing 200 (66.8 KB); public card API returns public projection only; vCard escaping correct; QR SVG 200; worker-tick endpoint 200 with secret (and GitHub Actions `worker-tick` workflow run success — cron replaced by Actions pinger due to Hobby daily-cron limit).
- **Demo data:** 2 `is_demo` accounts/profiles seeded with production encryption key (synthetic users, labeled demo).
- **Status changes:** staging-test deploy → now **exists** (was `BLOCKED_EXTERNAL`); Telegram live round trip → still `BLOCKED_EXTERNAL` (no bot token); contest status unchanged (`BLOCKED_CONTEST_RULES` / window ended).
- **Known deviations:** serverless worker = tick endpoint (GitHub Actions every 5 min) instead of long-running process; production permission remains `false` per preflight — this deployment is staging-test, not production release.

---

## Final update — 2026-09-09

- **F-03 MFA implemented and deployed** (TOTP + recovery codes + step-up on owner actions, `/me/security`).
- **Next.js 16.3.4 upgrade** shipped (all gates green: unit 192, integration 203, e2e 2, audit clean).
- **Demo event live**: `welcome-demo-meetup` with members, matching score-100 pair and mutual intro.
- Remaining external items: `RESEND_API_KEY` (real-user email OTP), `TELEGRAM_BOT_TOKEN` (live Telegram), legal review of `/legal/*` before commercial launch.

---

## Email transport live — 2026-09-10

- **Resend подключён к проду** (`RESEND_API_KEY`, `RESEND_FROM=onboarding@resend.dev`). Проверка: тестовое письмо доставлено на email владельца (Resend id `cbecbe10…`), прод-запрос OTP для реального (не-demo) аккаунта → `200 {ok:true}`.
- **Ограничение Resend test-mode:** без верифицированного домена письма уходят только на email владельца аккаунта Resend. Для приёма OTP произвольными пользователями: добавить домен в Resend → DNS-записи → `RESEND_FROM` на этот домен (админ-шаг, не код).

## Real-user email login verified end-to-end — 2026-09-10

- OTP request → email delivered (Resend, owner address) → code verified (user-provided) → **200 session issued** → authed profile API + GDPR export both 200. This closes the last functional gap of the auth flow on production: real (non-demo) users can now sign up and log in, subject to the Resend test-mode address restriction (domain verification pending for arbitrary recipients).

## Telegram live round trip CLOSED + latency fix — 2026-09-12

- **AC-38 closed with a real user**: web session → deep link → Telegram `/start` → `channel_bindings: active` (real chat) → bot confirmation "Telegram linked" delivered. All four inbound updates processed; binding + 3 replies sent.
- **telegram_link TTL 10m → 24h** (two-sided binding is the real gate; ADR-0001 precedent). Verified live: challenge expiry now +24h.
- **Latency fix**: `/api/webhooks/telegram` now processes the update right after the response via Next `after()` (bounded drain 3×5, `tickOnce` reuse; cron stays as backstop). Live-verified: webhook 200 in 1.49s, update `delivered` + reply `sent` with no manual tick.

# WELCOME — evidence index (Phase 6, final)

All verification evidence lives in `evidence/`. Production/staging deployment
never happened, so every artifact below is **local verification evidence**.

| File | What it is |
|---|---|
| `release-report.json` | Machine-readable release report conforming to `spec/contracts/release-report.schema.json` (status `PASS_LOCAL`, gates, integrations, blockers, spend 0 EUR) |
| `release-report-validation.txt` | Output + exit code (0) of `node scripts/validate-release-report.mjs` against the schema |
| `final-gates.json` | Machine summary of the LAST full gate run (`pnpm gates`, scripts/run-gates.mjs): the 7 release gates with exact commands, exit codes, durations and test-count lines; the previous run's stamp is kept in `previous_run`. The 10-gate Phase-6 run it replaced (it also ran audit:deps, drill:defect and the spec core tests) is in git history (commit `7605b00`) |
| `final-gates.log` | Full combined raw output of that run (typecheck → lint → unit → integration → e2e → build → scan:secrets), all exit 0 |
| `ACCEPTANCE_STATUS.md` | The 62-AC acceptance matrix with honest per-AC status (`PASS_LOCAL` / `BLOCKED_EXTERNAL` / `NOT RUN` / `BLOCKED_CONTEST_RULES`) + evidence pointer each |
| `usage-matrix.json` / `USAGE_MATRIX.md` | Black-box usage matrix over a local production build against the production database: 123 checks across modes A–S, 122 PASS / 0 FAIL / 1 SKIP. Mode S (packet 3) covers the provider registry, the ICS file, private goals, the four recommendation modes and `/me/connections` |
| `DEPLOY_NOTES_2026-09-15.md` | Operational notes: the two migrations (010, 011) that must run BEFORE the code, and the environment traps of a local live-matrix run |
| `DEFECT_DRILL.md` | Controlled defect drill summary: public-projection leak injected → gate FAIL (exit 1) → revert → PASS (exit 0), no residue |
| `defect-drill-fail.log` | Raw TAP output of the guard test WITH the injected defect (expected failure) |
| `defect-drill-pass.log` | Raw TAP output of the guard test after revert (expected pass) |
| `load-smoke.json` | AC-53 load smoke results (50 concurrent joins + 200 recommendation GETs vs a 200-member event) — **local-only indicative numbers**, not a production benchmark |
| `runtime/environment.md` | Honest implementation environment record: host, tool versions, executor (ZCode CLI agent in OpenClaw/AutoClaw session; AutoClaw browser preview NOT used — Playwright chromium used), DBs, env-var names, git state at gate run |
| `screenshots/landing-1280-en.png` | Landing, desktop 1280px, English (Playwright chromium, written by tests/e2e/landing.spec.ts) |
| `screenshots/landing-1280-ru.png` | Landing, desktop 1280px, Russian |
| `screenshots/landing-360-en.png` | Landing, mobile 360px, English |
| `screenshots/landing-360-ru.png` | Landing, mobile 360px, Russian |
| `screenshots/profile-editor.png` | Authenticated profile editor (`/me/profile`) |
| `screenshots/me-dashboard.png` | Authenticated dashboard (`/me`) |
| `screenshots/public-card-mobile.png` | Public profile card on mobile viewport |
| `screenshots/event-directory.png` | Event directory view |
| `screenshots/intro-reveal-panel.png` | Mutual-introduction private-contact reveal panel |
| `screenshots/organizer-campaign-stats.png` | Organizer campaign stats view |

Related (outside `evidence/`):

- `RELEASE_REPORT.md` — human release report (scope verdicts, gate table, digests, acceptance mapping, blockers, deviations).
- `.runtime/otp.log` (gitignored) — dev OTP sink; proof that OTP codes never enter git.
- `.github/workflows/ci.yml` — CI definition running the same gates + drill; **defined but never observed running on GitHub** (no push performed).

Not present on purpose: any staging/production deployment log, real Telegram
delivery transcript, contest submission receipt — none of these exist because
none of these were done.

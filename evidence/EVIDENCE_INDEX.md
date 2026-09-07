# WELCOME — evidence index (Phase 6, final)

All verification evidence lives in `evidence/`. Production/staging deployment
never happened, so every artifact below is **local verification evidence**.

| File | What it is |
|---|---|
| `release-report.json` | Machine-readable release report conforming to `spec/contracts/release-report.schema.json` (status `PASS_LOCAL`, gates, integrations, blockers, spend 0 EUR) |
| `release-report-validation.txt` | Output + exit code (0) of `node scripts/validate-release-report.mjs` against the schema |
| `final-gates.json` | Machine summary of the final full gate run: 10 gates, exact commands, exit codes, durations, test-count lines |
| `final-gates.log` | Full combined raw output of the final gate run (typecheck → lint → unit → integration → e2e → build → scan:secrets → audit:deps → drill:defect → spec core tests), all exit 0 |
| `ACCEPTANCE_STATUS.md` | The 62-AC acceptance matrix with honest per-AC status (`PASS_LOCAL` / `BLOCKED_EXTERNAL` / `NOT RUN` / `BLOCKED_CONTEST_RULES`) + evidence pointer each |
| `DEFECT_DRILL.md` | Controlled defect drill summary: public-projection leak injected → gate FAIL (exit 1) → revert → PASS (exit 0), no residue |
| `defect-drill-fail.log` | Raw TAP output of the guard test WITH the injected defect (expected failure) |
| `defect-drill-pass.log` | Raw TAP output of the guard test after revert (expected pass) |
| `load-smoke.json` | AC-53 load smoke results (50 concurrent joins + 200 recommendation GETs vs a 200-member event) — **local-only indicative numbers**, not a production benchmark |
| `runtime/environment.md` | Honest implementation environment record: host, tool versions, executor (ZCode CLI agent in OpenClaw/AutoClaw session; AutoClaw browser preview NOT used — Playwright chromium used), DBs, env-var names, git state at gate run |
| `screenshots/landing-1440-en.png` | Landing, desktop 1440px, English (Playwright chromium) |
| `screenshots/landing-1440-ru.png` | Landing, desktop 1440px, Russian |
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

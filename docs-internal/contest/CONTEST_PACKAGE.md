# WELCOME — Contest Package (evidence prepared — NOTHING submitted)

**Status: DRAFT — no post, no submission.** Per [spec/docs/08_CONTEST.md](../../spec/docs/08_CONTEST.md)
the official rules, deadline/timezone, eligibility, mandatory tags and the
submit destination are **not verified**; nothing may be published until they
are. Structure note: `spec/contest/SUBMISSION_CHECKLIST.md` does not exist in
this repo — this checklist is the fill-in package derived from the actual
contest sources (`spec/docs/08_CONTEST.md`, `spec/openspec/changes/15-contest-evidence/`).

Legend: `[x] PREPARED (local)` = artifact exists in the repo, produced locally.
`[ ] BLOCKED` = requires an external fact or action that has not happened.

## 1. Prepared evidence

| # | Item | Path / value | Status |
|---|---|---|---|
| 1 | Landing, desktop 1440, EN | `evidence/screenshots/landing-1440-en.png` | [x] PREPARED (local capture) |
| 2 | Landing, desktop 1440, RU | `evidence/screenshots/landing-1440-ru.png` | [x] PREPARED (local capture) |
| 3 | Landing, mobile 360, EN | `evidence/screenshots/landing-360-en.png` | [x] PREPARED (local capture) |
| 4 | Landing, mobile 360, RU | `evidence/screenshots/landing-360-ru.png` | [x] PREPARED (local capture) |
| 5 | Profile editor (`/me/profile`) | `evidence/screenshots/profile-editor.png` | [x] PREPARED (local capture) |
| 6 | Dashboard (`/me`) | `evidence/screenshots/me-dashboard.png` | [x] PREPARED (local capture) |
| 7 | Public card, mobile | `evidence/screenshots/public-card-mobile.png` | [x] PREPARED (local capture) |
| 8 | Event directory | `evidence/screenshots/event-directory.png` | [x] PREPARED (local capture) |
| 9 | Mutual-intro reveal panel | `evidence/screenshots/intro-reveal-panel.png` | [x] PREPARED (local capture) |
| 10 | Organizer campaign stats | `evidence/screenshots/organizer-campaign-stats.png` | [x] PREPARED (local capture) |
| 11 | Defect drill (leak → gate FAIL → revert → PASS) | `evidence/DEFECT_DRILL.md`, `defect-drill-fail.log`, `defect-drill-pass.log` | [x] PREPARED (local) |
| 12 | Load smoke (AC-53) | `evidence/load-smoke.json` | [x] PREPARED (local-only, indicative — not a production benchmark) |
| 13 | Release report | [RELEASE_REPORT.md](../../RELEASE_REPORT.md) + `evidence/release-report.json` (`PASS_LOCAL`) | [x] PREPARED |
| 14 | Full gate run (10 gates, all exit 0) | `evidence/final-gates.json`, `final-gates.log` | [x] PREPARED (local) |
| 15 | GitHub repo | https://github.com/nberezniker/welcome-p0 | [x] exists / [ ] BLOCKED for the contest: repo is **private** — making it public is the owner's call per the (unverified) rules |
| 16 | Exact commit SHA (evidence baseline) | `fd0236c80fc97cd023b6f791756a73a2b6620a98` | [x] PREPARED (deployment-prep commits follow this SHA; re-pin at submission time) |

## 2. BLOCKED / unchecked — need a live public URL or verified rules

| # | Item | Why it is blocked |
|---|---|---|
| A | [ ] Verified official contest rules (exact URL, screenshot of rules, deadline with timezone, eligibility, prior-work/reuse rules, mandatory hashtags/mentions, submission format & destination) | [spec/docs/08_CONTEST.md](../../spec/docs/08_CONTEST.md): rules never received — do not assume, do not shift dates |
| B | [ ] Live public demo URL (deployed app to demo from) | Nothing was ever deployed; production permission still false per preflight ([RELEASE_REPORT.md §6](../../RELEASE_REPORT.md)) |
| C | [ ] Live Telegram round-trip evidence | No bot token / public webhook URL configured |
| D | [ ] 90-second demo video (scenario in spec/docs/08_CONTEST.md) | Not recorded; needs a live deployment, two real test accounts, live channel evidence |
| E | [ ] X-post publication + submission | Never before rules verified (item A); the draft below is the only prepared artifact |

## 3. EN X-post draft — NOT POSTED, placeholders stay literal until verified

Template source: [spec/docs/08_CONTEST.md](../../spec/docs/08_CONTEST.md) «Черновик
публикации — НЕ ОТПРАВЛЕН» (fields preserved, EN rendering):

> Built WELCOME: one personal QR that works for any event. Before — your profile
> comes straight from registration; during — explainable matching; after — the
> next step stays with you. Contacts open only by your choice, no app install
> required. [ACTUAL AUTOCLAW ROLE]. Demo: [VERIFIED_PUBLIC_URL]. Checks and
> limitations: [EVIDENCE_URL]. [EXACT TAGS PER RULES]

Fill-in rules (from spec/docs/08_CONTEST.md):

- `[VERIFIED_PUBLIC_URL]` — only a URL that actually serves the deployed app at
  submission time. Never a localhost, preview that expired, or invented link.
- `[ACTUAL AUTOCLAW ROLE]` — only the factual, verified contribution statement.
- `[EVIDENCE_URL]` — link to the public evidence (repo/docs) once public.
- `[EXACT TAGS PER RULES]` — only the hashtags/mentions confirmed from the
  official rules (item A). No tags are guessed or invented here.
- Forbidden content per spec: mock users as traction, hypothetical percentages
  as results, third-party libraries presented as own code.

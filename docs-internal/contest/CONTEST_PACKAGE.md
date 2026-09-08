# WELCOME — Contest Package (rules VERIFIED 2026-09-08 — NOTHING submitted)

**Status: RULES VERIFIED / SUBMISSION WINDOW ENDED PER RULES — owner decision pending.**
No post, no form submission has been made. All verified facts below were read
live from the official sources on 2026-09-08 (Europe/Madrid) via the official
X post, the rules document export, and the live form HTML.

## 0. VERIFIED campaign facts (2026-09-08)

| Fact | Value | Source |
|---|---|---|
| Official campaign post | 2026-09-01 16:30 (CEST display) — https://x.com/AutoClawAIer/status/2094794913103614158 | X, live status page |
| Rules document | https://docs.google.com/document/d/1KqhT0rsLBiZfXVT700h2bTG6FH954n4hqTMGS-bENjY/edit ("Built with AutoClaw", last updated September 1, 2026) | text export saved at [evidence/contest/rules-export-2026-09-08.txt](../../evidence/contest/rules-export-2026-09-08.txt) |
| Submission form | https://docs.google.com/forms/d/1V9zGPk5u3-cPhBhVTZbU_zVf5vitQW4oT7LLh0inthI/viewform — OPEN (no closed marker) | live form HTML |
| Submission period | **September 1–7, 2026** — timezone NOT specified in the rules (documented gap) | rules doc |
| Participation reward | 1,500 AutoClaw credits per eligible participant, once; valid 30 days | rules doc |
| Top-5 reward | 1 month of AutoClaw Pro per project (US$100) | rules doc |
| Judging | practical value, completion/experiencability, creativity, clarity of presentation; likes/reposts/followers considered but not decisive | rules doc |
| How to participate | 1) public X post; 2) introduce project (screenshots/GIF/short video; demo link if available); 3) follow **@AutoClawAIer** and mention it in the post; 4) submit the form with the X post link + the email registered to the AutoClaw account | rules doc |
| Originality | must be own/team original work; no re-submission of the same project; no misrepresentation | rules doc |
| Required tags | **@AutoClawAIer mention + follow**; no hashtags mandated by the rules | rules doc |

### Form fields (verified from live form)

1. AutoClaw account email* 
2. Your X username* 
3. Link to your X post* 
4. Project name* 
5. Project category* — radio: Website / App or digital tool / Product prototype or demo / Other digital project
6. What does your project do, and how did you use AutoClaw?* (paragraph)
7. Public project or demo link (optional)
8. Confirmation* — checkbox: original work, post stays public during the campaign, AutoClaw may repost/feature with attribution.

### Honest status on the deadline

Rules define the period as Sep 1–7, 2026 with **no timezone and no late-entry
clause**. Verified on Sep 8, 2026 (Europe/Madrid): the calendar window has
ended; the form still technically accepts responses. Whether a late submission
counts is not knowable from the rules — **only the owner may decide to submit
late; AutoCoder will not post or submit without an explicit instruction.**

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
| 12 | Load smoke (AC-53) | `evidence/load-smoke.json` | [x] PREPARED (local-only, indicative) |
| 13 | Release report | [RELEASE_REPORT.md](../../RELEASE_REPORT.md) + `evidence/release-report.json` (`PASS_LOCAL`) | [x] PREPARED |
| 14 | Full gate run (10 gates, all exit 0) | `evidence/final-gates.json`, `final-gates.log` | [x] PREPARED (local) |
| 15 | Verified rules text export | [evidence/contest/rules-export-2026-09-08.txt](../../evidence/contest/rules-export-2026-09-08.txt) | [x] VERIFIED 2026-09-08 |
| 16 | GitHub repo | https://github.com/nberezniker/welcome-p0 (CI green) | [x] exists; [ ] contest needs it **public** (owner call) |
| 17 | Exact commit SHA (evidence baseline) | `eac7327…` on main (re-pin at submission time) | [x] PREPARED |

## 2. Still missing before a submission could happen

| # | Item | Why |
|---|---|---|
| B | Live public demo URL | Nothing deployed yet (Vercel deploy prepared, needs owner accounts). Demo link is optional per rules but strongly recommended for judging. |
| D | Visuals for the post | 3–5 screenshots/GIF exist locally; final pick + optional short video still to be made from a live deploy. |
| E | X post from the OWNER's account + form submission | Requires owner's X account, AutoClaw account email, and explicit go-ahead (late-entry risk accepted). |

## 3. EN X-post draft — NOT POSTED (tags per verified rules)

> Built WELCOME with AutoClaw: one personal QR that works for any event. Before
> — your profile comes straight from event registration; during — explainable
> people worth meeting; after — the next step stays with you. Contacts open
> only after both sides agree, no app install needed. Built end-to-end with
> AutoClaw (Next.js app, tests, release evidence). Demo: [VERIFIED_PUBLIC_URL]
> Repo: https://github.com/nberezniker/welcome-p0
>
> @AutoClawAIer

Fill-in rules:

- `[VERIFIED_PUBLIC_URL]` — only a URL that actually serves the deployed app at
  submission time. Never a localhost or an invented link.
- Repo must be made public by the owner BEFORE posting (or removed from the draft).
- Mention `@AutoClawAIer` and follow the account (rules requirement; no hashtags required).
- Forbidden content per spec: mock users as traction, hypothetical percentages
  as results, third-party libraries presented as own code.

## 4. Form fill-out plan (if owner orders submission)

- email → the email registered to the owner's AutoClaw account (reward delivery depends on it)
- X username / post link → from the actually published post
- Project name → WELCOME
- Category → App or digital tool
- Description → 2–3 sentences: what it does + how AutoClaw was used (honest: implemented in an AutoClaw/OpenClaw agent session with ZCode CLI execution; deterministic tests, security gates, release report)
- Demo link → live public URL (only if deployed and health-checked)
- Confirmation → checkbox implies the post stays public and work is original — verify before checking.

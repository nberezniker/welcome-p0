# Two-user walkthrough — live, with screenshots

**Target:** https://welcome.colmogravity.net (Vercel, `cdg1`)
**Date:** 2026-09-22 · runs at 11:07, 11:09 (refused by the OTP guard), 11:10, 11:16 local time (log holds all four)
**Viewports:** 390×844 for every mobile capture, 1280×900 for the desktop one. Every navigation
carried `?lang=en` (a documented per-visit override, `src/i18n/locale.ts`) so the shots and the
assertions read in one language; no account preference was written.
**Runner:** [`scripts/two-user-walkthrough.mjs`](../../scripts/two-user-walkthrough.mjs) — refuses to run
without an explicit `--target`, writes only into this directory.

## Who walked, and where

| role | account | persona |
|---|---|---|
| **A** — proposes | `demo2@welcome.test` | Дмитрий Ковалёв (synthetic demo account) |
| **B** — arrives through the QR, answers | `marta.demo@welcome.test` | Marta Ruiz (synthetic demo account) |
| supplement (read-only) | `demo1@welcome.test` | Анна Смирнова (synthetic demo account) |

All three are `is_demo` accounts whose OTP codes this deployment exposes by design
(`AUTH_EXPOSE_DEMO_OTP` + a demo account's `is_demo`, `src/integrations/email/index.ts`), which is
why no identity had to be created. Event: `/e/welcome-demo-meetup`
("WELCOME Demo Meetup — Product & Growth"), the seat the demo seed already populates.

## Step log

Reference run **11:16** (`walkthrough-log.json` → `runs[3]`). `action` is the step's own wall clock
from its first interaction (or navigation) to the moment it was usable; `fcp→usable` is the number
the brief asks for — wall clock from the document's first-contentful-paint to usable.

| # | step | action | fcp | fcp→usable | screenshot |
|---|---|---|---|---|---|
| 1 | A signs in and opens the demo event | 3219 ms | 312 ms | **167 ms** | `01-a-event-member-state.png` |
| 2 | A opens the directory and proposes the introduction | 1669 ms | 100 ms | **1567 ms** | `02-a-reveal-chooser.png`, `03-a-proposal-sent.png` |
| 3 | B signs in and opens the card from the QR URL | 1724 ms | 172 ms | **189 ms** | `04-b-card-from-qr-url.png` |
| 4 | B opens the event | 225 ms | 108 ms | **115 ms** | `05-b-event-already-member.png` |
| 5 | B sees the request and answers it | 1313 ms | 244 ms | **1067 ms** | `06-b-intro-card-already-answered.png`, `07-b-mutual-reveal.png` |
| 6 | A sees the mutual state and the reveal | 707 ms | 180 ms | **526 ms** | `08-a-mutual-reveal.png` |
| 7 | a stranger opens A's public card at phone size | 436 ms | 316 ms | **118 ms** | `09-a-public-card-stranger.png` |
| 8 | the directory at desktop size | 1444 ms | 252 ms | **1191 ms** | `10-directory-desktop-1280.png` |
| 9 | the directory at its slug URL (**the defect**) | 3475 ms | 420 ms | 3053 ms | `11-defect-directory-slug-url.png` |
| 10 | supplement: a pending request as its recipient sees it | 1862 ms | 88 ms | **902 ms** | `12-supplement-pending-card.png` |

**The whole ten-step journey took ~18 seconds of wall clock** once the first page had painted
(09:16:21 → 09:16:39). Every step was usable within ~1.6 s of first paint; the two slowest numbers
are the defect page (a crash page has to be waited out) and the directory's member fetch.

### What the live run proved, state by state

* **A proposed** — `POST /api/introductions → 200, already_existed=false` (a genuinely fresh request),
  the member panel's own link carried the event UUID
  (`/me/events/36b3bad0-…/directory`), the reveal chooser was filled, and the card's button turned
  into **"Request sent"** (`03-a-proposal-sent.png`).
* **B arrived from the QR URL** — the runner read the served code
  (`/api/public/profiles/F4FL0_fORTXgnUA6Yqh-tA/qr.svg`, 34 module rows) and then opened the card URL
  it encodes, as a scanner would — no other route. The card rendered **Дмитрий Ковалёв** with its QR
  expanded and the **"Propose an introduction"** affordance, because B shares the event
  (`04-b-card-from-qr-url.png`).
* **Before consent nothing was revealed** — B's drawer answered
  `state=pending`, `revealed=[]`, and the card rendered zero reveal blocks (run 11:07 log).
* **B accepted** — `POST /respond → 200`; B ticked **Telegram and WhatsApp**, and the reveal that came
  back held **one row: `telegram_username @dmitry_demo`** — the WhatsApp number was asked for and still
  kept out, because the intersection of both sides' current sets is what decides.
* **A's side** — `Mutual — contacts revealed`, one row, `telegram @marta_demo`, plus the
  agreement-only calendar control that exists solely in the mutual state (`08-a-mutual-reveal.png`).
* **A stranger's card** — phone-sized, QR open, one public contact row, no private values
  (`09-a-public-card-stranger.png`).

## Friction and defects

| id | severity | what |
|---|---|---|
| **D1** | **high (deployed, unfixed on prod)** | `/me/events/<slug>/directory` is a **500** — the product's own error surface, then a crash page. See the dedicated section below. |
| **F1** | **medium (product constraint)** | The brief's order — *A proposes, then B joins* — is **not reachable through the UI**. An event-context proposal answers `403 target_not_member` unless the counterparty is already an active member, and **both** UI entry points (the event directory and the card CTA) always send `event_id`. So B must be in the room first; the local spec asserts this (it shows the directory is empty until B joins) instead of stepping around it. The product therefore cannot express "invite somebody who has not joined yet" — which is exactly the story the owner described. |
| **F2** | **medium (could not be done live)** | **B's join could not be performed**: both demo personas are already seeded members of the only demo event, so the event page honestly showed the member state and offered no join action (`05-b-event-already-member.png`). The real join (button → member panel → directory visibility) is covered by the local spec on a fresh account. |
| **F3** | **low (inherent)** | The product keeps **one introduction per pair per event context**, and the demo seed already spends demo1↔demo2 (mutual) and owner↔Marta (mutual). Between two synthetic personas exactly one fresh pair existed (demo2↔Marta) — this walkthrough created it (a fresh `pending`) and answered it. A re-run therefore cannot recreate a pending request: the runner says so, names the card for the state it actually captured, and the pending *visual* comes from the read-only supplement (below). |
| **F4** | **low–medium (UX)** | The directory opens in mode **`intent`** ("they seek what I offer"). A profile with no offers gets an empty list there, so finding a specific attendee costs one extra tap on **"Everyone"** — the runner had to do it to see anybody. The empty state's own hint is honest about why. |
| **F5** | **low (copy)** | A visitor who **is signed in but shares no event** is told **"Sign in to connect"** — the card's only CTA when `findSharedEvent` is null. Observed in the local spec; the affordance that would actually work for them does not appear. |
| **F6** | **info (capture constraint, not a defect)** | The directory's recommendation strip lists the **operator's own account** (`Nikita Berezniker`, and on B's page a reveal row `@nik_nikiti4`) for A and B. Every directory/B-side capture was therefore **framed on an element** — the members section, the intro card — so no screenshot publishes the operator's card or contact, and the runner records where the marker was found instead. |
| **F7** | **cosmetic** | On the error surface the auto-focused `<h1>` renders a visible focus ring although the component sets `outline-none` — visible in `11-defect-directory-slug-url.png`. |
| **F8** | **info (correct guard)** | The per-account OTP guard (**3 codes / 15 min**) refused the third sign-in inside one quarter-hour (`429 rate_limited`, recorded in the log). The walkthrough can therefore run at most ~3× per 15 minutes per persona — the product guarding its own door. |
| **F9** | **info (framework noise, filtered)** | Next's own RSC prefetches are aborted as a navigation lands (`?_rsc=… ERR_ABORTED`). The runner filters those out of the friction list so they cannot bury a real error. |

### D1 — the defect, in full

**Symptom.** `https://welcome.colmogravity.net/me/events/welcome-demo-meetup/directory?lang=en`
answers **HTTP 200 with a crash page**: the product's own surface ("Something went wrong on our
side", `11-defect-directory-slug-url.png`) plus, in the console,
`Minified React error #441` and `[client_error] segment render failed`. No `main`, no directory
controls, no member list.

**Cause (reproduced locally with the full error).**
`src/app/me/events/[eventId]/directory/page.tsx` looked the event up with

```sql
SELECT id, name, slug FROM events WHERE id = $1 OR slug = $1 LIMIT 1
```

For a **slug** the `id = $1` comparison makes Postgres cast the literal to `uuid`, which is not a
failing lookup but a thrown error:

```
PostgresError: invalid input syntax for type uuid: "e2e-two-user-walkthrough"
    at EventDirectoryPage
```

The page advertised slug support (`OR slug = $1`) and never delivered it. Its sibling API route
handles exactly this correctly (`isUuid(eventIdOrSlug)`, then an `id` or a `slug` branch), which is
why the API answered happily while the page died — and why nobody had hit it: the product's own
navigation always uses the UUID (the member panel's "Open directory" link).

**Status: fixed in the working tree, NOT deployed** — the page now branches on `isUuid` exactly like
its own API route (I verified locally that the same slug URL then renders the directory, and that
the UUID path is unchanged, which `pnpm test:e2e` also covers). `11-defect-directory-slug-url.png`
therefore still shows the live state at the moment of this run, and remains valid evidence of the
deployed defect.

**Severity: high for a URL a person can paste or bookmark; the product's own paths are unaffected.**

### What could not be done live, plainly

1. **B's join** (F2) — both personas are seeded members; the honest member state is captured, and the
   real join is covered locally.
2. **A fresh pending proposal on a re-run** (F3) — spent by this walkthrough. The pending state as its
   recipient sees it is therefore shown from a **different, read-only pair** in the same event
   (`12-supplement-pending-card.png`): chip "Waiting for response", "Waiting for your answer.", the six
   reveal checkboxes, Accept/Decline. **Nothing was answered there** — that row belongs to the
   operator's demo and was left exactly as it was.
3. **The acceptance itself, a second time** — performed live in the 11:07 run
   (`POST /respond → 200`, `state=pending revealed=[]` → mutual). The 11:16 run records the card in
   the state it is actually in instead of pretending otherwise.
4. **An organizer-console shot.** The brief allowed one "if it fits naturally" — it does not here:
   A (demo2) is not an organizer, and using the organizer account would have put the operator's own
   dashboard and its registration data in frame. The 1280px shot is the directory instead.

## Production footprint of this run

- **Written:** exactly one introduction + its two consents (demo2↔Marta, event context), the audit
  rows that go with them, two mutual outbox notices (telegram channel; send-time consent/channel
  rules apply, no new values travel — the bodies carry a link only), the sessions, and 8 OTP codes
  (3 for demo2, 3 for Marta, 2 for demo1) plus one refused request.
- **Not touched:** no identity created, no profile or contact edited, no other introduction answered,
  nothing deleted, nothing deployed, pushed or committed.

## How to re-run

```bash
node scripts/two-user-walkthrough.mjs --target=https://welcome.colmogravity.net
```

Expected on a re-run: the proposal step reports the pair is already spent, the B-side step records the
mutual card, and the pending supplement is skipped because the acceptance succeeded live. Roughly
three runs per 15 minutes per persona is the ceiling the OTP guard allows.

## What the evidence says (my reading — the verdict is the owner's)

| criterion | reading | evidence |
|---|---|---|
| **Does the mechanic work end to end for two real people?** | **Yes.** A proposed, B arrived from the QR and answered, both sides saw the mutual state and exactly one revealed value. | fresh `POST /api/introductions → 200 already_existed=false`; `POST /respond → 200`; one reveal row per side |
| **Speed** | **Good.** The whole journey is ~18 s; every step usable within ~1.6 s of first paint; nothing felt slow except the crash page. | timings table |
| **Privacy boundary** | **Holds, and is the strongest part.** Nothing before consent; one row after; WhatsApp asked for and withheld; the stranger's card leaks nothing. | live drawer reads + `pnpm test:e2e` spec, 3 green runs |
| **Determinism** | **Good locally** (3/3 green, `tests/e2e/two-user-walkthrough.spec.ts`), **one-shot live** by the product's own one-intro-per-pair rule. | this report + `pnpm gates` |
| **Clarity for a first-time organiser** | **Mixed.** Reading the flow works, but the default directory mode hides everyone until you switch modes (F4), a signed-in non-member is told to sign in (F5), and the invited-friend narrative the owner described cannot be expressed in the UI at all (F1). | F1, F4, F5 |
| **Defects found** | 1 real deployed defect (D1, fixed in the tree, not deployed), 3 frictions worth a decision, 2 cosmetic/informational. | table above |

# The live JOIN run — two-user walkthrough, 2026-09-22 14:18 UTC

**Target:** https://welcome.colmogravity.net (production, NOT redeployed — the tree is ahead of it)
**Runner:** [`scripts/two-user-walkthrough.mjs`](../../scripts/two-user-walkthrough.mjs) · log: `walkthrough-log.json` → `runs[5]`
**Viewports:** 390×844 (mobile captures), 1280×900 (the desktop one). Every navigation carried `?lang=en`.

## What this run added: the step that could not be shown before

The two-person journey was missing one step on production — **the second person
joining the event**. Both older demo personas were seeded members, so the event
page honestly rendered the member state and the join could never appear.

| role | account | persona | state at the start of this run |
|---|---|---|---|
| **A** — proposes, owns the QR | `demo2@welcome.test` | Дмитрий Ковалёв | seeded member of `welcome-demo-meetup` |
| **B** — arrives through the QR, **joins**, accepts | `lucia.demo@welcome.test` | Lucía Ferrer | **NOT a member** — the seeder gives her no membership |

`pnpm demo:reset --i-know-this-is-production --unjoin=lucia.demo@welcome.test`
returned her to that non-member state after the run (and removed the pair's
introduction), so the demo is left demonstrable.

## The journey, step by step (runs[5])

| # | step | action | fcp→usable | screenshots |
|---|---|---|---|---|
| 1 | A signs in and opens the demo event (member state) | 4951 ms | 236 ms | `01-a-event-member-state.png` |
| 2 | B signs in and opens the card **from the QR URL** | 1454 ms | 92 ms | `02-b-card-from-qr-url.png` |
| 3 | **B opens the event and JOINS it for real** | 806 ms | 161 ms | `03-b-event-before-join-nonmember.png`, `04-b-event-after-join-member.png` |
| 4 | the same card URL now offers the introduction | 232 ms | 22 ms | `05-b-card-intro-after-join.png` |
| 5 | A opens the directory and proposes (reveal chooser) | 1650 ms | 1552 ms | `06-a-reveal-chooser.png`, `07-a-proposal-sent.png` |
| 6 | B sees the request and accepts | 1474 ms | 1101 ms | `08-b-proposal-pending.png`, `09-b-mutual-reveal.png` |
| 7 | A sees the mutual state and the reveal | 1097 ms | 955 ms | `10-a-mutual-reveal.png` |
| 8 | a stranger opens A's public card at 390px | 401 ms | 56 ms | `11-a-public-card-stranger.png` |
| 9 | the directory at 1280px | 1766 ms | 1449 ms | `12-directory-desktop-1280.png` |
| 10 | the directory at its slug URL (the deployed defect) | 3127 ms | 3021 ms | — (capture SKIPPED: the crash page carries the operator's row) |

**Whole journey: 14:18:16 → 14:18:34 UTC ≈ 18.6 s** of wall clock; every step
usable within ~1.6 s of first paint.

### What the run proved, in the deployment's own words

* **The join was real.** `POST /api/events/36b3bad0-…/join → 200`; the page
  reloaded into `"You are a member of this event."` and the join control was
  rendered **0** times; `PATCH /api/me/memberships/… (directory_visible) → 200`
  made her findable. The database agrees: her `event_memberships` row was
  created at 14:18:24.456Z with `directory_visible=true`.
* **The join is what turns the card's introduction on.** The very URL B scanned
  in step 2 (no affordance: `no-connection=0, sign-in=1, intro=0` — the signed-in
  non-member was still told to sign in, because **the fix is in the tree, not
  deployed**) renders the introduction after the join (`no-connection=0,
  sign-in=0, intro=1`).
* **The introduction flowed.** `POST /api/introductions → 200,
  already_existed=false` → B's card `state=pending, revealed=[]` → `POST
  /respond → 200` → mutual with **exactly one** revealed row per side
  (`@dmitry_demo` for B, `@lucia_demo` for A).
* **An anonymous stranger** gets the sign-in CTA and one public contact row.

## Production footprint

* **Seed (`scripts/seed-demo-event.mts --allow-production-demo`)** created: her
  account (`is_demo`, `lucia.demo@welcome.test`), her profile
  (`/p/tG-fsHADuqw6Md0Egs97eA`), her two encrypted contacts. It also **updated the
  demo event's row** (its schedule had passed, so it rolled to next Saturday —
  `starts_at 2026-09-12T16:00Z → 2026-09-26T16:00Z` — plus the name/consent
  text/access mode the seeder always re-applies) and re-upserted the 8 synthetic
  CSV registrations, demo1/demo2's memberships, Marta's profile/contacts and the
  existing demo1↔demo2 mutual introduction. The operator half was skipped
  (`SEED_OWNER_NAME` unset).
* **Walkthrough created:** 1 membership (Lucía), 1 introduction (demo2↔Lucía,
  mutual), 2 consents, 3 outbox notices, 5 audit rows (`event.joined`,
  `intro.consent_implicit`, `intro.requested`, `intro.mutual`, B's `intro.mutual`)
  plus sessions and 2 OTP codes. Event totals went 4 memberships → 5 and 5
  introductions → 6 (see `production-join-after-walkthrough.json`).
* **Reset removed** (after the run, `production-join-after-walkthrough-apply.txt`):
  **exactly** 1 introduction row, its 3 notices and the 2 consents the schema
  cascades — scope check MATCH on every counter, audit rows kept (1124 → 1124) —
  and **exactly** 1 `event_memberships` row for Lucía (whole table 5 → 4, MATCH),
  nothing else. The audit trail of the join and the introduction (5 rows) stays.
* **State left in** (`production-join-final-state.json`): Lucía is a non-member
  again (0 membership rows, 0 introductions with demo2), her profile and both
  contacts survive, the demo event is back to 4 memberships / 5 introductions,
  and the demo is ready to be walked again.

## Still not done live

1. **The card's honest no-shared-event state could not be shown live** — it is in
   the tree, and the deployment still serves the old copy (`sign-in=true` for a
   signed-in visitor, recorded in step 2's notes as a defect). Verified locally
   instead: `tests/e2e/two-user-walkthrough.spec.ts` (the real state, before and
   after the join) and `tests/e2e/design-gate.spec.ts` (fold, axe, 44px and the
   localized copy in all three languages).
2. **The slug-URL directory defect is still deployed** (`main=1`,
   `directory controls=1` → the error surface): fixed in the tree since the
   previous run, still a 500 on this build.
3. **The recommendation strip's self-exclusion was verified against the API for
   one persona** (`lucia`: absent from her own strip in all four modes, while
   `Marta Ruiz`/`Nikita Berezniker` appear). The second persona's four-mode strip
   could not be re-measured: her OTP budget (3 codes / 15 min) was spent by the
   walkthrough and two verification sign-ins. Her **directory** self-exclusion
   was measured in the same window.
4. **The join response has no `already_member` field on this build** — the
   deployed join route is older than the tree's (which returns it). Recorded as
   `already_member=undefined` rather than silently assumed false.

# Byte-compatibility of the default look — the measurement

The acceptance bar says the default theme must be **byte-compatible with today's
look**. "Today" means the tree as committed before the theme work
(`HEAD = 99b752e`), so the claim is only worth anything if it is measured against
that tree rather than against itself. This is what was measured, and how.

## Method

1. **Baseline.** `git stash push -u` (both modified files and the new theme
   files), then `next dev` on the resulting pre-theme tree, then a throwaway
   Playwright capture of two elements at 390×844:
   `/p/<slug>` card and `/e/<slug>` card, with **no theme cookie and no
   `?theme=`** — i.e. the page a stranger gets. The Next dev-tools overlay was
   hidden in every capture (`nextjs-portal { display: none }`); it is not part of
   the page and it moves between two shots of the same document.
2. **After.** Restore the work (`git stash pop`), `next dev` again, same two
   elements, same viewport, same account — so the card content (including the QR
   image, whose pixels depend on the public slug) is identical between the two
   runs. The database was never touched by the stash.
3. **Compare** the PNG bytes with `cmp`/SHA-256. No tolerance: equal or not.

The same capture, repeated through the e2e suite, additionally shows
**un-themed === `?theme=soft`** (the evidence PNGs in this folder are that pair),
so the two equalities chain into: *pre-theme look === un-themed === `soft`*.

## Result

Two claims, both byte-level, no tolerance:

**(a) Pre-theme build vs themed build, same fixture.** Captured in one database
state (the stash did not touch the data), so the card content — including the QR
image, whose pixels depend on the generated public slug — is identical on both
sides of the comparison:

| Surface @390 | Pre-theme build (`HEAD 99b752e`) | After (no theme) |
|---|---|---|
| Card `/p/<slug>` | `59734` B | `59734` B — identical bytes |
| Event `/e/<slug>` | `36927` B | `36927` B — identical bytes |

```
sha256 f5b06a47ac3cc537b6cbce01a0847574c58675072e7338590c273c5991315d25   (card)
sha256 4d78f2201043e5b1a36bf6c87428d657fd8136c14f5ed6e7137ee3b421055fa8   (event)
```

**(b) Un-themed vs `?theme=soft`, inside one build** — asserted structurally by
the e2e suite and observed byte-for-byte in **two independent runs**, i.e. against
two different fixtures:

| Run | Card | Event |
|---|---|---|
| first | `59734` B, visitor == `soft` | `36927` B, visitor == `soft` |
| second | `59738` B, visitor == `soft` | `36927` B, visitor == `soft` |

The card differs between the two runs by 4 bytes because a fresh e2e run resets
the database and regenerates the public slug, and the slug is inside the QR image.
The **equality** is what matters and it holds in both; the event card carries no
slug-dependent pixel, so its digest is reproducible
(`4d78f2201043e5b1…`).

Chained, (a) + (b) give: *pre-theme look == un-themed == `soft`*.

Reproducing (a) requires the pre-theme tree: `git stash push -u`, run `next dev`
plus a card/event capture at 390, `git stash pop`, repeat, `cmp` the PNGs — the
four files must be captured in **one** database state or the QR alone makes them
differ. That is why it is a recorded measurement rather than a standing gate;
what the gate suite asserts instead is computed-style and geometry equality
(above) plus the pinned `:root` values. The un-themed page is
also proved structurally inside one build by
`tests/e2e/design-themes.spec.ts` ("the default look is untouched"): the computed
styles of body, card, title, bio, all three chip kinds, eyebrow and both button
families are **deep-equal** between no theme and `?theme=soft`, and the geometry
of card/title/primary action is equal to within 0.5px. The `:root` token values
themselves are pinned to the pre-theme literals by `tests/unit/theme.test.ts`.

## After `premium` was added

`premium` is a fourth value set for the same token names, so it cannot touch the
default look — but "cannot" is the kind of claim this document exists to replace,
so it was re-measured by the same method as (a), against **one** database state:

| Surface @390, no theme | HEAD (before `premium`) | Working tree (after) |
|---|---|---|
| Card `/p/<slug>` | `43224` B | `43224` B — identical bytes |
| Event `/e/<slug>` | `36927` B | `36927` B — identical bytes |

```
sha256 3e88da6bc6365b7e8acf37b31d7494ea07dc720ac85a5c5f7c92d3c23674fe6d   (card)
sha256 4d78f2201043e5b1a36bf6c87428d657fd8136c14f5ed6e7137ee3b421055fa8   (event)
```

Three things are worth noting about this run:

* The event digest `4d78f2201043e5b1…` is **the same digest recorded in claim (a)
  above**, from a different session, a different database state and the earlier
  tree. That is the strongest form this document can offer: the event card has no
  slug-dependent pixel, so its bytes are reproducible across all of it.
* The card is `43224` B here against `59734` B in claim (a) because the fixture is
  a different one (a shorter bio), so the QR encodes a different slug. Within THIS
  comparison the fixture is constant, which is what makes the equality meaningful.
* `soft`'s token block is `:root` and was **not edited**; the `SOFT_AS_SHIPPED`
  deep-equal pin in `tests/unit/theme.test.ts` is what keeps that true, and it is
  byte-level about the token values rather than about a rendered page.
* The only card-markup change was `id` + `aria-labelledby` on the chip lists.
  Neither affects layout, colour or paint, and the equality above is the
  observable form of that: nothing about the painted card moved.

### A note on the two `evidence/screenshots/mini-landing-*.png` files

Those are full-page shots of the public **card** (taken by
`tests/e2e/onboarding-landing.spec.ts`), and they change on every e2e run: the run
resets the database, the slug is regenerated, and the QR image inside the card
encodes it. They are not landing-page images and their churn is not a rendering
change.

The measurements in the table above still stand as recorded: they were taken
against the pre-theme tree (`99b752e`) and the tree that shipped the three themes,
neither of which this change modified.

## Reproducing the screenshots

The images in this folder are now regenerable without any checkout juggling:

```
pnpm capture:themes --card=/p/<slug> --event=/e/<slug>
```

`scripts/capture-theme-evidence.mjs` writes the same filenames the e2e suite
asserts about and records a SHA-256 per file in `theme-capture.json`, so a re-run
can be compared to a previous one instead of merely eyeballed. This does **not**
replace claim (a) above, which compares two different *builds* and still needs the
stash dance; it removes the separate problem that the folder used to be evidenced
by a capture nobody had committed.

## What is *not* covered by this

* The comparison is Chromium-only, at one device pixel ratio, on one machine —
  the same limits as the rest of the e2e suite.
* It covers the public card and the public event. The cabinet is themed by the
  same tokens (one markup, one token layer) but was not pixel-compared; its
  structure is untouched, and it is listed as deliberately undesigned in
  `docs-internal/design/THEMES.md`.

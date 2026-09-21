# Design themes — contract, measurements and the decisions behind them

Four design directions over **one markup**: `soft` (the default, today's look),
`swiss` (International Typographic Style), `poster` (constructivist poster) and
`premium` (warm monochrome). They exist so the owner can judge the card and the
event on a real phone in each direction, not as a user preference — which is why
they are a review mode (see "Decisions" below).

* Token sets: [`src/app/globals.css`](../../src/app/globals.css)
* Primitives (what a theme is, how one is resolved): [`src/lib/theme.ts`](../../src/lib/theme.ts)
* Request plumbing: [`src/proxy.ts`](../../src/proxy.ts) (`?theme=`), [`src/lib/theme-page.ts`](../../src/lib/theme-page.ts) (`getTheme()`), [`src/app/api/theme/route.ts`](../../src/app/api/theme/route.ts) (the switcher)
* Gates: [`tests/unit/theme.test.ts`](../../tests/unit/theme.test.ts) (resolution, the default pin, **the AA contrast pairs**, and **the chip-group naming**), [`tests/e2e/design-themes.spec.ts`](../../tests/e2e/design-themes.spec.ts) (axe, geometry, overflow, tap targets, localization)
* Evidence: [`evidence/design-themes/`](../../evidence/design-themes/) — screenshots at 390px, the measured table, and the byte-compatibility proof
* Re-capture: [`scripts/capture-theme-evidence.mjs`](../../scripts/capture-theme-evidence.mjs) (`pnpm capture:themes`)

## The token contract

Every colour, radius, shadow and type weight a theme may touch is one of these
names. A theme is a **value set for the same names**; nothing else selects a
look, and `tests/unit/theme.test.ts` fails if a theme forgets a token (which
would leak one `soft` value into it) or invents one.

| Token | soft (default, `:root`) | swiss | poster | premium | Reaches |
|---|---|---|---|---|---|
| `--t-canvas` | `#f5f4ee` | `#f4f4f4` | `#fbfaf7` | `#f7f2eb` | `bg-paper`, `body` |
| `--t-surface` | `#fff` | `#fff` | `#fff` | `#fff` | `bg-white`, `text-white` |
| `--t-ink` | `#18241f` | `#101112` | `#0b0b14` | `#1d1a16` | `bg-ink`, `text-ink` |
| `--t-muted` | `#59665e` | `#54585c` | `#4e4d63` | `#6e6c65` | `text-muted` |
| `--t-line` | `#dce0d6` | `#888888` | `#0b0b14` | `#dcd6cf` | `border-line` |
| `--t-line-strong` | `#b9c1b7` | `#888888` | `#0b0b14` | `#8b8782` | `.btn-outline` border |
| `--t-field-line` | `#ccd3c6` | `#888888` | `#0b0b14` | `#8b8782` | `.input` border |
| `--t-accent` | `#c93d26` | `#c93d26` | `#0047ab` | `#8a5a2b` | `bg-accent`, `text-accent`, focus ring |
| `--t-accent-hover` | `#bf3d29` | `#a8301c` | `#003580` | `#74491f` | `.btn-accent:hover` |
| `--t-accent-pale` | `#fff0e9` | `#fdf2f0` | `#e6e9ff` | `#f6efe3` | `bg-accent-pale` |
| `--t-ink-hover` | `#2c3a33` | `#2a2c30` | `#26263a` | `#34312b` | `.btn-primary:hover` |
| `--t-pine` | `#284d3d` | `#101112` | `#16207a` | `#3f3d37` | `text-pine` (chip ink) |
| `--t-mint` | `#e6efe4` | `#efefef` | `#e3e6ff` | `#f4ede4` | `bg-mint` (chip field) |
| `--t-offer` / `--t-offer-ink` | emerald-50 / emerald-800 | `#e9e9e9` / `#101112` | `#0047ab` / `#fff` | `#f4ede4` / `#3f3d37` | `.chip-offer` |
| `--t-need` / `--t-need-ink` | sky-50 / sky-800 | `#101112` / `#fff` | `#0047ab` / `#fff` | `#f4ede4` / `#3f3d37` | `.chip-need` |
| `--t-rule-card` | `1px` | `2px` | `2px` | `1px` | `.card` / `.card-tight` border width |
| `--t-radius-md…3xl` | `.375/.5/.75/1/1.5rem` | `0` | `3px` | `2/3/4/6/10px` | `rounded-md…3xl` |
| `--t-radius-full` | `calc(infinity * 1px)` | `0` | `calc(infinity * 1px)` | `6px` | `rounded-full` |
| `--t-shadow-card` | Tailwind `shadow-sm` | `0 0 #0000` | `0 0 #0000` | warm `0 1px 2px` + `0 1px 3px -1px` | `shadow-sm` |
| `--t-heading-weight` | `800` | `800` | `700` | `700` | `font-extrabold` |
| `--t-heading-tracking` | `-0.025em` | `-0.02em` | `-0.03em` | `-0.015em` | `tracking-tight` |

`soft` lives on `:root` and there is deliberately **no** `html[data-theme="soft"]`
block: an un-themed page renders `soft`, so writing it twice is how the two copies
would drift. `DEFAULT_THEME` in `src/lib/theme.ts` names it for the switcher and
the tests.

`--t-shadow-card` is `0 0 #0000` and not `none` in the flat themes because
Tailwind composes the theme value into a `box-shadow` **list**; `none` inside a
list is invalid CSS and the whole declaration would be dropped rather than doing
nothing.

## Measured contrast — every pair, per theme

Measured with the WCAG 2.1 relative-luminance formula (sRGB), text pairs against
a 4.5:1 bar (AA) and rules against 3:1 (a UI boundary). Nothing here is "improved
contrast": these are the numbers the values were chosen to hit.

**These numbers are now a gate, not a table.** `tests/unit/theme.test.ts` reads
the token values out of `globals.css`, resolves them (hex and `oklch`) to sRGB and
asserts the AA pairs for all four themes; the boundary pairs are asserted at 3:1
for every theme that claims one, and the default theme's sub-3:1 hairlines are
pinned as the **recorded** pre-existing shortfall they are. The tables below are
the same measurement, written down, and the two are produced by the same method —
so a value that drifts out of the bar fails a gate instead of quietly
contradicting a document.

One method note. Four rows (the `oklch` offer/need pairs in `soft`) previously
read **7.29** and **7.09**; computed from the literal as the test does, they are
**7.19** and **7.05**. The values did not change — the earlier figure was taken
from the browser's own resolution of `oklch()`, this one from the CSS Color 4
conversion of the same literal. Every hex pair in the table reproduces the earlier
figure to within 0.005, which is what identifies the difference as method rather
than colour.

### soft (default) — unchanged from the pre-theme palette

| Pair | Ratio |
|---|---|
| ink on canvas / on surface | 14.54 / 16.02:1 |
| muted on canvas / on surface | 5.47 / 6.02:1 |
| white on accent (the primary action) | 5.03:1 |
| accent on surface / on canvas | 5.03 / 4.56:1 |
| accent on accent-pale | 4.52:1 |
| white on accent-hover `#bf3d29` | 5.36:1 |
| white on ink / on ink-hover | 16.02 / 11.93:1 |
| pine on mint (chip) | 8.04:1 |
| muted on mint | 5.11:1 |
| offer-ink on offer · need-ink on need | 7.19 / 7.05:1 |
| line-strong (a boundary here) on surface / on canvas | **1.85 / 1.68:1** |
| line (hairline) on surface / on canvas | 1.34 / 1.22:1 |

The two bold rows are the recorded shortfall: unlike `swiss` and `poster`, `soft`
never had 3:1 boundaries, because it is the pre-theme palette and is pinned
byte-for-byte. It is *worse* than a hairline problem — `.input` and `.btn-outline`
are real controls — so the number is recorded here and pinned in the unit test
rather than quietly raised, which would be a redesign of the page every visitor
sees.

### swiss

| Pair | Ratio |
|---|---|
| ink on canvas / on surface | 17.19 / 18.90:1 |
| muted on canvas / on surface | 6.52 / 7.17:1 |
| accent on surface / on canvas | 5.03 / 4.57:1 |
| white on accent (the primary action) / on accent-hover | 5.03 / 6.76:1 |
| accent on accent-pale | 4.58:1 |
| white on ink / on ink-hover | 18.90 / 13.99:1 |
| pine on mint | 16.44:1 |
| offer-ink on offer · need-ink on need | 15.57 / 18.90:1 |
| muted on mint | 6.24:1 |
| line-strong (= line = field-line, `#888888`) on surface / on canvas | 3.54 / 3.22:1 |

### poster

| Pair | Ratio |
|---|---|
| ink on canvas / on surface | 18.76 / 19.59:1 |
| muted on canvas / on surface | 7.84 / 8.19:1 |
| accent on surface / on canvas | 8.44 / 8.08:1 |
| white on accent (the primary action) / on accent-hover | 8.44 / 11.53:1 |
| accent on accent-pale | 7.02:1 |
| white on ink / on ink-hover | 19.59 / 14.78:1 |
| pine on mint | 11.19:1 |
| offer-ink on offer · need-ink on need | 8.44 / 8.44:1 |
| muted on mint | 6.64:1 |
| line-strong (= line = field-line = ink) on surface / on canvas | 19.59 / 18.76:1 |

### premium

| Pair | Ratio |
|---|---|
| ink on canvas / on surface | 15.56 / 17.33:1 |
| muted on canvas / on surface | 4.72 / 5.26:1 |
| accent on surface / on canvas | 5.87 / 5.27:1 |
| white on accent (the primary action) / on accent-hover | 5.87 / 7.73:1 |
| accent on accent-pale | 5.14:1 |
| white on ink / on ink-hover | 17.33 / 12.96:1 |
| pine on mint · offer-ink on offer · need-ink on need | 9.35:1 (all three identical) |
| muted on mint | 4.52:1 |
| line-strong (= field-line) on surface / on canvas | 3.57 / 3.20:1 |
| line (hairline, recorded) on surface / on canvas | 1.44 / 1.29:1 |

## What makes it premium

Not gold, not gradients, not more of anything — **restraint with one warm
temperature**. Five specific things, all of them choices with a number behind
them:

1. **One warm ramp, hue 74°.** Canvas, chip field, hairlines and ink are steps of
   a single warm-neutral ladder (`#f7f2eb` → `#f4ede4` → `#dcd6cf` → `#3f3d37` →
   `#1d1a16`), so the page reads as one material rather than as several greys that
   happen to sit together.
2. **Hue is spent exactly once.** `--t-accent` is a burnished bronze `#8a5a2b`
   and it is the only saturated value in the theme. That is also why `--t-pine`
   is a warm *neutral* `#3f3d37` and not a green: pine and accent are the two
   dark values a reviewer compares at a glance, and if pine were also a hue they
   would have been the first indistinguishable pair in the set. The accent is
   also deliberately not a red — it must not be confusable with `soft`'s coral.
3. **All three chip kinds are one colour.** `--t-mint`, `--t-offer` and
   `--t-need` are the same value, and so are the three chip inks, so an offer chip
   and a need chip are pixel-identical. The group is carried by its heading and by
   the chip's own words instead — see "Colour is not the only carrier" below.
4. **Hairlines and near-square geometry.** `--t-line` is a true 1.44:1 seam, not a
   rule: the card is a printed sheet whose edge is a fold. Corner radii collapse to
   a 2–6px scale with `--t-radius-full: 6px`, so a chip is a soft-cornered plate
   rather than a pill, and the 44px buttons are almost rectangular.
5. **A quieter voice.** 700 heading weight at `-0.015em` (the loosest tracking in
   the set) against `poster`'s 700/-0.03em and `soft`/`swiss`' 800: the same
   hierarchy, read calmly.

## Colour is not the only carrier

Point 3 above is the risk this theme carries, so it is not left to a document:

* The card names **each chip list by its own heading** (`aria-labelledby` on the
  `<ul>`, `src/app/p/[slug]/page.tsx`), so a screen reader announces "How I can
  help, list, 1 item" instead of unattached chips. The `<section>` is named too,
  which additionally makes it a `region` landmark.
* `tests/unit/theme.test.ts` pins that naming, and pins that the offers and needs
  headings are **different, non-empty strings in all three locales** — so a
  "cleanup" that strips the attribute or merges the two labels fails a gate
  instead of leaving position as the only difference.
* `tests/e2e/design-themes.spec.ts` asserts it live in `premium`: the two chip
  kinds are **measured** to be the same colour (the premise of the test, so a
  future hue change is a deliberate decision rather than a silent escape), the two
  lists are then found **by their accessible names**, and the chip texts are
  disjoint.

## What was adjusted, and why

* **Nothing in `soft`.** Its values are the shipped ones; the palette already
  cleared AA everywhere (tightest pair: accent-on-paper 4.56:1), and the default
  look is pinned byte-for-byte (below), so "darkening for safety" would have been
  a redesign wearing a measurement's clothes.
* **`swiss` accent kept `#c93d26`.** The brief asked for this value to be
  measured and adjusted only if needed. It **passes at 5.03:1** both as white text
  on the accent button and as accent text on the theme's white surface (4.57:1 on
  the `#f4f4f4` canvas). Changing it would have been a look, not a fix.
* **`swiss` canvas is `#f4f4f4`, not `#ffffff`.** Not a contrast decision: at pure
  white the `.btn-light` hover (`hover:bg-paper`), the card's paper-grey language
  chips (`!bg-paper !text-muted`) and their own border would all be white on
  white — an invisible control, not a style choice.
* **`swiss` hairlines are `#888888`** (3.54:1 on white, 3.22:1 on the canvas) so
  the card frame clears the 3:1 non-text bar rather than being a decorative
  whisper.
* **`swiss` accent-pale was darkened** from a first-draft `#faeeeb` (which
  measured **4.43:1**, below AA) to `#fdf2f0` (**4.58:1**).
* **`poster` accent is `#0047ab`** (true cobalt), not a lighter "screen" cobalt:
  a first draft at `#1d4ed8` measured 6.70:1 (fine) but a brighter draft of the
  same hue family loses the button's white text fastest, and cobalt at 8.44:1
  both ways leaves room for the darker `hover` without re-measuring.
* **`poster` chips are solid** (cobalt / near-black with white text, 8.44:1)
  instead of two pale tints, because a pale tint on a pale indigo canvas is the
  one place a "loud" theme turns muddy.
* **`premium`'s canvas was made *lighter*, and that is the counter-intuitive
  one.** `--t-muted` is fixed at `#6e6c65`, and a language pill paints muted text
  on the **canvas** (`chip !bg-paper !text-muted`), so the canvas is the binding
  ground: `#f7f2eb` is the deepest warm step at which `#6e6c65` still clears AA
  (**4.72:1**). The first draft ground (`#efece5`) measured **4.45:1** — a fail —
  and a "richer" ground was the thing that had to give, not the muted value.
* **`premium`'s chip field is not pure white**, at 1.16:1 against the card
  (`#f4ede4` on `#fff`, against `swiss`' 1.15:1 and `soft`'s 1.18:1), so a chip is
  never invisible on the surface it sits on — the same reasoning as `swiss`'
  ground, applied one level down.
* **`premium`'s boundaries clear 3:1 on the *darker* ground.** `--t-line-strong`
  and `--t-field-line` are a real UI boundary, and the binding side is the canvas,
  so they were darkened until they cleared it there (3.20:1 on canvas, 3.57:1 on
  white) — `swiss`' mistake in reverse would have been to check only against
  white.
* **`premium`'s `--t-line` stays a hairline on purpose** (1.44:1). It is a card
  seam, not a control, and the number is recorded above rather than hidden by
  rounding or "fixed" by darkening the whole theme.

### A documentation correction that came out of this work

Writing the contrast test meant computing every theme's real numbers, and three
`poster` rows in the previous version of this document were **stale**: the palette
was lightened in `9c9d0cb` ("lighten the poster theme — it read as heavy, not
editorial") and its comments and these tables kept the earlier values. Corrected
here: `--t-canvas` `#f0eeff` → `#fbfaf7`, `--t-rule-card` `3px` → `2px`,
`--t-heading-weight` `900` → `700`, `--t-heading-tracking` `-0.045em` →
`-0.03em`, and the derived ratios with them (ink on canvas 17.14 → **18.76:1**,
accent on canvas 7.38 → **8.08:1**). No `poster` *value* changed in this work —
only the document that described it. The claim two paragraphs below that swiss and
poster shift the card by "2px and 4px" was wrong for the same reason: both shift
it by 2px, which is the 2px `--t-rule-card` border.

## Decisions

1. **`data-theme` on `<html>`.** The token sets hang off the document element, so
   there is exactly one place a theme is applied and the cabinet inherits colours,
   radii and weights automatically. The cabinet gets **no theme-specific layout** —
   that is deliberate (see "Not styled" below), not an oversight.
2. **The switcher is a review mode, not a preference.** A theme is explicit (a
   `?theme=` query or the `welcome_theme` cookie) or absent. Absent means **no
   `data-theme` attribute and no bar**: a stranger opening a shared card sees
   exactly today's page. That is the whole reason `resolveRequestTheme` returns
   `null` rather than `'soft'`.
3. **No `accounts.theme` column.** A language is what a person says about
   themselves and belongs on the account (`accounts.locale`, migration 014). A
   review theme is something one person is doing for an hour, and it must not
   follow them into someone else's session on a shared device. Cookie + query is
   proportionate, and — like `?lang=` — `?theme=` writes the current render and
   the cookie only. No consent event, no audit row: a theme is not consent.
4. **`?theme=` is scoped to the same four public entry points as `?lang=`**
   (`/`, `/login`, `/p/*`, `/legal/*`). Everything else (`/e/<slug>`, the cabinet)
   is reached with the cookie the query just set, because the bar renders in the
   layout on every page. A stray query parameter still cannot reshape a signed-in
   surface.
5. **The bar is in flow at the END of the document** — never `fixed`, never
   `sticky`. The card's and the event's primary actions are the last thing in
   their cards, so a bottom-anchored bar would cover exactly what is being
   judged, and a top-anchored one would eat the first screen. In flow at the end
   it can do neither. Cost: on a long card the reviewer scrolls to the end to
   switch theme. Numbers below.
6. **Switching drops the `?theme=` query.** The query outranks the cookie by
   design, so reloading `?theme=swiss` after choosing Poster would re-apply swiss
   and make the switcher look broken (and "Exit review" would re-enter review
   mode as it reloaded). The client reloads via `location.replace` on a URL with
   the parameter removed; `tests/e2e/design-themes.spec.ts` pins that.
7. **The bar is a labelled `<section>`.** An un-landmarked strip of controls at
   the end of the document is an axe `region` finding. The content is real, so it
   gets a region rather than an exemption — and since the axe assertion now admits
   no impact level, that exemption could not have survived quietly anyway.
8. **A theme may not use colour as its only carrier.** It is a requirement of
   `premium`, not a nicety of it: a monochrome theme that leans on hue fails the
   same bar as one that leans on colour, and one that leans on position fails it
   too. The chip groups therefore announce themselves (see "Colour is not the only
   carrier").
9. **The theme list is the app's own.** `tests/e2e/design-themes.spec.ts` imports
   `THEMES` from `src/lib/theme.ts` rather than declaring its own copy, so a fifth
   theme is swept by the gate instead of leaving the suite green and untested.

## Verified, with the numbers

Two viewports — **390×844** (iPhone 14 class) and **360×740** (common small
Android) — card and event, five passes (four themes plus the visitor). Full table:
[`evidence/design-themes/measurements.json`](../../evidence/design-themes/measurements.json).

| Check | Result |
|---|---|
| axe, **any impact** | **0 violations in all 20 samples** (visitor included); the `color-contrast` rule reports **0 nodes** everywhere. The severity filter is gone — see the note in the spec. |
| Horizontal overflow | **0px** at both widths, every theme, both pages (`scrollWidth === innerWidth`) |
| Review bar above the card | never: bar top ≥ card bottom in all 16 themed samples (e.g. event @390: card ends 596.5, bar starts 636.5) |
| Bar covers the primary action | never: bar top is below the action's bottom everywhere (e.g. card @360: action ends 1173.875, bar starts 1310.875) |
| Tap targets in the bar | smallest control **57×44 px** in all 16 themed samples — the 44px floor holds |
| Switcher labels | EN `Soft / Swiss / Poster / Premium`, RU `Мягкая / Швейцарская / Плакатная / Премиальная`, ES `Suave / Suizo / Póster / Premium`; four names, distinct within each locale, asserted against the dictionary values in order; dictionary parity test green |
| AA contrast | asserted for all four themes from the token values (`tests/unit/theme.test.ts`); tables above |
| Default look byte-compatible | pre-theme build vs themed build, card and event PNGs **byte-identical** (`cmp` + SHA-256); see [`BYTE_COMPAT.md`](../../evidence/design-themes/BYTE_COMPAT.md) |
| One markup for all themes | no page or component was forked; the only markup added is the bar itself, plus the `id`/`aria-labelledby` pair naming each chip list |
| New runtime dependencies | none |

**First screen, measured (not asserted).** At 390×844 the event shows, above the
fold, the title (bottom 197), the primary action (499.5–543.5) **and** the review
bar (636.5) — bar strictly below both, nothing covered. At 360×740: title 233,
action 535.5–579.5, bar 688.5 — the same. The **card** is a different story and it
is a pre-existing one: its title is at 101 (visible), but its primary action sits
at 1073.875, below the fold, because the card is 1214.875px tall. That is identical
in the visitor pass (1073.875) — the bar cannot be the cause, being below the card's
bottom edge (1254.875 vs 1214.875), and the equality is machine-checked to within
0.5px. Moving that action above the fold would mean restructuring the card, which
this work deliberately does not do.

`swiss` and `poster` shift the card's bottom edge by **2px each** at 390
(1216.875 against the visitor's 1214.875). That is their 2px `--t-rule-card`
border showing up, i.e. the theme actually applying — not a layout difference.
**`premium` ships a 1px seam, so its geometry is identical to the visitor pass to
the pixel (1214.875 / 596.5)**, which is the intended reading: the warm theme
changes the surface, not the layout.

## Not styled — deliberately undesigned

Parts of the app that a theme does **not** touch, so nobody mistakes them for
forgotten work:

1. **Cabinet layout.** `/me/*`, `/organizer/*` inherit colours, radii, weights and
   the border width, but keep their own structure and spacing. Only the public
   card and the public event were designed per theme.
2. **Arbitrary-value decoration.** `rounded-[36px]`/`rounded-[48px]` (the landing
   page's mock phone and hero shapes) and `shadow-xl` on that mock are literal
   values in the markup, outside the radius/shadow token scale — which is why
   `premium`'s 6px `--t-radius-full` does not reach them.
3. **The input placeholder** (`#9aa69c` on white) measures **2.53:1** — below AA,
   in every theme, as it is today. It is not body text, axe does not read
   `::placeholder`, and darkening it would change the default look, which is
   pinned byte-for-byte. Recorded here rather than silently changed.
4. **The default theme's control boundaries** (`--t-line-strong` / `--t-field-line`
   at 1.85:1 / 1.68:1). The other three themes clear 3:1; `soft` does not, because
   it is the pre-theme palette. Recorded and pinned, not raised. This is the same
   class of finding as the placeholder above and is called out in "Measured
   contrast".
5. **Status colours outside the token set** — `text-red-700` for field errors, and
   any Tailwind palette utility used directly in markup. They are semantic (error),
   not decorative.
6. **The printable badge sheet** (`/organizer/events/[id]/badges`) is plain CSS for
   A4 paper and is not part of the screen theme; the review bar itself carries
   `no-print`.
7. **Content.** Themes change no copy, no field, no consent text — only how the
   same information looks.

### Known gap, recorded rather than closed

The card's **language pills** (`en`, `ru`, …) are a `<ul>` with no heading, so
they have no accessible name — nothing above them says "Languages". This is not a
colour-versus-position problem (they are not confused with the taxonomy chips),
it needs a new string in three dictionaries, and it belongs with a broader pass on
the card's list semantics rather than with this change. Noted here so it is a
known gap and not an unnoticed one.

## Re-running the evidence

```
pnpm exec playwright test tests/e2e/design-themes.spec.ts   # gates + measurements + screenshots
node --import tsx --test tests/unit/theme.test.ts           # resolution, default pin, AA contrast, chip naming
pnpm gates                                                  # all seven release gates
```

To re-capture the screenshots against a fixture that already exists — the thing
that was missing before, when the folder could not be regenerated:

```
pnpm capture:themes --card=/p/<slug> --event=/e/<slug>
```

It writes the same filenames the suite asserts about, plus
`theme-capture.json` with a SHA-256 per file, so two runs are comparable rather
than merely similar.

The byte-compatibility comparison needs the pre-theme tree, so it is a measured
one-off (method in `BYTE_COMPAT.md`), not part of the gate suite — a pixel
snapshot against a fixed baseline would flake on any font or browser change.

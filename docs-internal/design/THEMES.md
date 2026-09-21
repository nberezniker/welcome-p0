# Design themes — contract, measurements and the decisions behind them

Three design directions over **one markup**: `soft` (the default, today's look),
`swiss` (International Typographic Style) and `poster` (constructivist poster).
They exist so the owner can judge the card and the event on a real phone in each
direction, not as a user preference — which is why they are a review mode
(see "Decisions" below).

* Token sets: [`src/app/globals.css`](../../src/app/globals.css)
* Primitives (what a theme is, how one is resolved): [`src/lib/theme.ts`](../../src/lib/theme.ts)
* Request plumbing: [`src/proxy.ts`](../../src/proxy.ts) (`?theme=`), [`src/lib/theme-page.ts`](../../src/lib/theme-page.ts) (`getTheme()`), [`src/app/api/theme/route.ts`](../../src/app/api/theme/route.ts) (the switcher)
* Gates: [`tests/unit/theme.test.ts`](../../tests/unit/theme.test.ts), [`tests/e2e/design-themes.spec.ts`](../../tests/e2e/design-themes.spec.ts)
* Evidence: [`evidence/design-themes/`](../../evidence/design-themes/) — screenshots at 390px, the measured table, and the byte-compatibility proof

## The token contract

Every colour, radius, shadow and type weight a theme may touch is one of these
names. A theme is a **value set for the same names**; nothing else selects a
look, and `tests/unit/theme.test.ts` fails if a theme forgets a token (which
would leak one `soft` value into it) or invents one.

| Token | soft (default, `:root`) | swiss | poster | Reaches |
|---|---|---|---|---|
| `--t-canvas` | `#f5f4ee` | `#f4f4f4` | `#f0eeff` | `bg-paper`, `body` |
| `--t-surface` | `#fff` | `#fff` | `#fff` | `bg-white`, `text-white` |
| `--t-ink` | `#18241f` | `#101112` | `#0b0b14` | `bg-ink`, `text-ink` |
| `--t-muted` | `#59665e` | `#54585c` | `#4e4d63` | `text-muted` |
| `--t-line` | `#dce0d6` | `#888888` | `#0b0b14` | `border-line` |
| `--t-line-strong` | `#b9c1b7` | `#888888` | `#0b0b14` | `.btn-outline` border |
| `--t-field-line` | `#ccd3c6` | `#888888` | `#0b0b14` | `.input` border |
| `--t-accent` | `#c93d26` | `#c93d26` | `#0047ab` | `bg-accent`, `text-accent`, focus ring |
| `--t-accent-hover` | `#bf3d29` | `#a8301c` | `#003580` | `.btn-accent:hover` |
| `--t-accent-pale` | `#fff0e9` | `#fdf2f0` | `#e6e9ff` | `bg-accent-pale` |
| `--t-ink-hover` | `#2c3a33` | `#2a2c30` | `#26263a` | `.btn-primary:hover` |
| `--t-pine` | `#284d3d` | `#101112` | `#16207a` | `text-pine` (chip ink) |
| `--t-mint` | `#e6efe4` | `#efefef` | `#e3e6ff` | `bg-mint` (chip field) |
| `--t-offer` / `--t-offer-ink` | emerald-50 / emerald-800 | `#e9e9e9` / `#101112` | `#0047ab` / `#fff` | `.chip-offer` |
| `--t-need` / `--t-need-ink` | sky-50 / sky-800 | `#101112` / `#fff` | `#0b0b14` / `#fff` | `.chip-need` |
| `--t-rule-card` | `1px` | `2px` | `3px` | `.card` / `.card-tight` border width |
| `--t-radius-md…3xl` | `.375/.5/.75/1/1.5rem` | `0` | `3px` | `rounded-md…3xl` |
| `--t-radius-full` | `calc(infinity * 1px)` | `0` | `calc(infinity * 1px)` | `rounded-full` |
| `--t-shadow-card` | Tailwind `shadow-sm` | `0 0 #0000` | `0 0 #0000` | `shadow-sm` |
| `--t-heading-weight` | `800` | `800` | `900` | `font-extrabold` |
| `--t-heading-tracking` | `-0.025em` | `-0.02em` | `-0.045em` | `tracking-tight` |

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

### soft (default) — unchanged from the pre-theme palette

| Pair | Ratio |
|---|---|
| ink on canvas | 14.54:1 |
| ink on surface | 16.02:1 |
| muted on canvas / on surface | 5.47 / 6.02:1 |
| white on accent (the primary action) | 5.03:1 |
| accent on surface / on canvas | 5.03 / 4.56:1 |
| accent on accent-pale | 4.52:1 |
| pine on mint (chip) | 8.04:1 |
| muted on mint | 5.11:1 |
| offer-ink on offer · need-ink on need | 7.29 / 7.09:1 |
| white on ink | 16.02:1 |

### swiss

| Pair | Ratio |
|---|---|
| ink `#101112` on canvas `#f4f4f4` / on surface | 17.19 / 18.90:1 |
| muted `#54585c` on canvas / on surface | 6.52 / 7.17:1 |
| accent `#c93d26` on canvas / on surface | 4.57 / 5.03:1 |
| white on accent (CTA) / on accent-hover `#a8301c` | 5.03 / 6.76:1 |
| accent on accent-pale `#fdf2f0` | 4.58:1 |
| pine on mint `#efefef` | 16.44:1 |
| offer-ink on offer `#e9e9e9` | 15.57:1 |
| need-ink on need `#101112` | 18.90:1 |
| muted on mint | 6.24:1 |
| white on ink-hover `#2a2c30` | 13.99:1 |
| line `#888888` on surface / on canvas | 3.54 / 3.22:1 |

### poster

| Pair | Ratio |
|---|---|
| ink `#0b0b14` on canvas `#f0eeff` / on surface | 17.14 / 19.59:1 |
| muted `#4e4d63` on canvas / on surface | 7.16 / 8.19:1 |
| accent `#0047ab` on canvas / on surface | 7.38 / 8.44:1 |
| white on accent (CTA) / on accent-hover `#003580` | 8.44 / 11.53:1 |
| accent on accent-pale `#e6e9ff` | 7.02:1 |
| pine `#16207a` on mint `#e3e6ff` | 11.19:1 |
| offer-ink on offer (cobalt) / need-ink on need | 8.44 / 19.59:1 |
| muted on mint | 6.64:1 |
| white on ink-hover `#26263a` | 14.78:1 |
| line (= ink) on surface / on canvas | 19.59 / 17.14:1 |

### What was adjusted, and why

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
* **`poster` chips are solid** (cobalt / near-black with white text, 8.44 and
  19.59:1) instead of two pale tints, because a pale tint on a pale indigo canvas
  is the one place a "loud" theme turns muddy.

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
   the end of the document is an axe `region` finding (moderate). The content is
   real, so it gets a region rather than an exemption.

## Verified, with the numbers

Two viewports — **390×844** (iPhone 14 class) and **360×740** (common small
Android) — card and event, four themes including the visitor pass. Full table:
[`evidence/design-themes/measurements.json`](../../evidence/design-themes/measurements.json).

| Check | Result |
|---|---|
| axe, serious + critical | **0** in all 16 samples (visitor pass included); the `color-contrast` rule reports **0 nodes** everywhere |
| Horizontal overflow | **0px** at both widths, every theme, both pages (`scrollWidth === innerWidth`) |
| Review bar above the card | never: bar top ≥ card bottom in all 12 themed samples (e.g. event @390: card ends 596.5, bar starts 636.5) |
| Bar covers the primary action | never: bar top is below the action's bottom everywhere (e.g. card @360: action ends 1175.9, bar starts 1314.9) |
| Tap targets in the bar | smallest control **57×44 px** — the 44px floor holds |
| Switcher labels | EN `Soft / Swiss / Poster`, RU `Мягкая / Швейцарская / Плакатная`, ES `Suave / Suizo / Póster`; dictionary parity test green |
| Default look byte-compatible | pre-theme build vs themed build, card and event PNGs **byte-identical** (`cmp` + SHA-256); see [`BYTE_COMPAT.md`](../../evidence/design-themes/BYTE_COMPAT.md) |
| One markup for all themes | no page or component was forked; the only markup added is the bar itself |
| New runtime dependencies | none |

**First screen, measured (not asserted).** At 390×844 the event shows, above the
fold, the title (bottom 197), the primary action (499.5–543.5) **and** the review
bar (636.5) — bar strictly below both, nothing covered. At 360×740: title 233,
action 535.5–579.5, bar 688.5 — the same. The **card** is a different story and it
is a pre-existing one: its title is at 101 (visible), but its primary action sits
at 1073.9, below the fold, because the card is 1214.9px tall. That is identical in
the visitor pass (1073.875) — the bar cannot be the cause, being below the card's
bottom edge (1254.9 vs 1214.9), and the equality is machine-checked to within
0.5px. Moving that action above the fold would mean restructuring the card, which
this work deliberately does not do.

Swiss and poster shift the card's bottom edge by 2px and 4px respectively at 390.
That is the `--t-rule-card` border width showing up (2px and 3px per side), i.e.
the theme actually applying — not a layout difference.

## Not styled — deliberately undesigned

Parts of the app that a theme does **not** touch, so nobody mistakes them for
forgotten work:

1. **Cabinet layout.** `/me/*`, `/organizer/*` inherit colours, radii, weights and
   the border width, but keep their own structure and spacing. Only the public
   card and the public event were designed per theme.
2. **Arbitrary-value decoration.** `rounded-[36px]`/`rounded-[48px]` (the landing
   page's mock phone and hero shapes) and `shadow-xl` on that mock are literal
   values in the markup, outside the radius/shadow token scale.
3. **The input placeholder** (`#9aa69c` on white) measures **2.53:1** — below AA,
   in every theme, as it is today. It is not body text, axe does not read
   `::placeholder`, and darkening it would change the default look, which is
   pinned byte-for-byte. Recorded here rather than silently changed.
4. **Status colours outside the token set** — `text-red-700` for field errors, and
   any Tailwind palette utility used directly in markup. They are semantic (error,
   offer/need before this change), not decorative.
5. **The printable badge sheet** (`/organizer/events/[id]/badges`) is plain CSS for
   A4 paper and is not part of the screen theme; the review bar itself carries
   `no-print`.
6. **Content.** Themes change no copy, no field, no consent text — only how the
   same information looks.

## Re-running the evidence

```
pnpm exec playwright test tests/e2e/design-themes.spec.ts   # gates + measurements + screenshots
node --import tsx --test tests/unit/theme.test.ts           # contract, default pin, resolution
pnpm gates                                                  # all seven release gates
```

The byte-compatibility comparison needs the pre-theme tree, so it is a measured
one-off (method in `BYTE_COMPAT.md`), not part of the gate suite — a pixel
snapshot against a fixed baseline would flake on any font or browser change.

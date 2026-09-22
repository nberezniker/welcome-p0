# The design token contract — and how to add a direction back

**One design ships.** Its colours, radii, shadows and type weights are the
`--t-*` tokens in [`src/app/globals.css`](../../src/app/globals.css), carried by
`:root`, with `@theme` mapping the utility names onto them. Nothing selects a
second set: there is no `data-theme` attribute anywhere in `src/`, no `?theme=`,
no cookie, no switcher.

This document exists for two reasons:

1. it records **what the shipped values are and what they measure**, so a change
   to one of them is a deliberate decision rather than a drift; and
2. it records **exactly what to add back** if a second design direction ever needs
   comparing on real pages — the token layer was kept precisely so that stays
   cheap.

## What happened to the four directions

The card and the event were reviewed in four directions at once
(`soft`/`swiss`/`poster`/`premium` — International Typographic Style,
constructivist poster, warm monochrome), rendered by ONE markup with four token
sets and switched by a review bar that only appeared when a theme was explicit.
The owner judged them on a real phone on real pages and **chose the default
look**. The comparison then served its purpose and was removed: the three other
token blocks, the switcher, the review bar, the `Theme` type, the `?theme=`
override and the `welcome_theme` cookie are all gone, and one pass per surface is
what the gates verify now.

Kept, on purpose:

* **the token layer itself** (`--t-*` + the `@theme` mapping). It is what made
  four directions cheap, it costs nothing, and it is the mechanism a future
  direction is added with;
* **the measurements** below, for the design that ships;
* **the reasoning behind the three that did not ship**, at the end of this file,
  clearly marked. It is guidance for a future editor — mostly about which kinds
  of value failed a contrast bar and why — not a description of the product.

The review screenshots went with the comparison: `evidence/design-themes/` held
four directions of a design that no longer exists and could not be regenerated
once the switcher was gone, so the folder was removed rather than kept as a stale
pretence of a live comparison. The design gate writes what is live now to
[`evidence/design/`](../../evidence/design/) — screenshots at 390px and the
measured table for the shipped design.

## The token contract

Every colour, radius, shadow and type weight the design may touch is one of these
names. A second direction would be **a value set for the same names**; nothing
else selects a look, and [`tests/unit/design-tokens.test.ts`](../../tests/unit/design-tokens.test.ts)
fails if a direction misses a token (which would leak one value into it) or
invents one.

| Token | Ships as (`:root`) | Reaches |
|---|---|---|
| `--t-canvas` | `#f5f4ee` | `bg-paper`, `body` |
| `--t-surface` | `#fff` | `bg-white`, `text-white` |
| `--t-ink` | `#18241f` | `bg-ink`, `text-ink` |
| `--t-muted` | `#59665e` | `text-muted` |
| `--t-line` | `#dce0d6` | `border-line` |
| `--t-line-strong` | `#b9c1b7` | `.btn-outline` border |
| `--t-field-line` | `#ccd3c6` | `.input` border |
| `--t-accent` | `#c93d26` | `bg-accent`, `text-accent`, focus ring |
| `--t-accent-hover` | `#bf3d29` | `.btn-accent:hover` |
| `--t-accent-pale` | `#fff0e9` | `bg-accent-pale` |
| `--t-ink-hover` | `#2c3a33` | `.btn-primary:hover` |
| `--t-pine` | `#284d3d` | `text-pine` (chip ink) |
| `--t-mint` | `#e6efe4` | `bg-mint` (chip field) |
| `--t-offer` / `--t-offer-ink` | emerald-50 / emerald-800 | `.chip-offer` |
| `--t-need` / `--t-need-ink` | sky-50 / sky-800 | `.chip-need` |
| `--t-rule-card` | `1px` | `.card` / `.card-tight` border width |
| `--t-radius-md…3xl` | `.375/.5/.75/1/1.5rem` | `rounded-md…3xl` |
| `--t-radius-full` | `calc(infinity * 1px)` | `rounded-full` |
| `--t-shadow-card` | Tailwind `shadow-sm` | `shadow-sm` |
| `--t-heading-weight` | `800` | `font-extrabold` |
| `--t-heading-tracking` | `-0.025em` | `tracking-tight` |

Two details a future editor must not lose:

* **The values live on `:root` and only there.** A `:root` block plus a
  `html[data-theme="…"]` block for the same direction is how the two copies drift
  apart; the shipped direction has no `[data-theme="…"]` counterpart for exactly
  that reason.
* **`@theme` is deliberately not `@theme inline`.** Plain CSS in globals.css and
  the inline `style={{ background: 'var(--color-pine)' }}` the funnel legend
  carries read `var(--color-*)` directly, and inlining would delete those
  variables. The mapping is also what lets markup say `bg-ink` and `text-muted`
  instead of a colour — a design direction changes a value here, never a page.

`--t-shadow-card` is `0 0 #0000` and not `none` in a flat direction because
Tailwind composes the theme value into a `box-shadow` **list**; `none` inside a
list is invalid CSS and the whole declaration would be dropped rather than doing
nothing.

## Measured contrast — the shipped design

Measured with the WCAG 2.1 relative-luminance formula (sRGB), text pairs against
a 4.5:1 bar (AA) and control boundaries against 3:1 (WCAG 1.4.11). Nothing here is
"improved contrast": these are the numbers the values were chosen to hit.

**These numbers are a gate, not a table.** `tests/unit/design-tokens.test.ts`
reads the token values out of `globals.css`, resolves them (hex and `oklch`) to
sRGB and asserts the AA pairs; the boundary pairs are asserted as the recorded
pre-existing shortfall they are. The table below is the same measurement, written
down, and the two are produced by the same method — so a value that drifts out of
the bar fails a gate instead of quietly contradicting a document.

One method note. Four rows (the `oklch` offer/need pairs) previously read **7.29**
and **7.09**; computed from the literal as the test does, they are **7.19** and
**7.05**. The values did not change — the earlier figure was taken from the
browser's own resolution of `oklch()`, this one from the CSS Color 4 conversion
of the same literal. Every hex pair in the table reproduces the earlier figure to
within 0.005, which is what identifies the difference as method rather than
colour.

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

The two bold rows are a recorded shortfall, not an oversight: this palette never
had 3:1 boundaries, and `.input` and `.btn-outline` are real controls. Raising
them would restyle every page every visitor sees, so the number is recorded here
and pinned in the unit test (as "still below 3:1") rather than quietly raised.

The coral itself is the reason the whole rule exists: the reference landing's
coral (`#d84932`) measured **4.27:1** against white — below AA both as accent text
on paper and as white text on the accent button. The shipped accent is `#c93d26`
(**5.03:1** both ways), and every value above was measured rather than picked.

## Colour is not the only carrier

The token layer permits a direction to paint an offer chip and a need chip with
the same value — one of the non-shipped directions did exactly that, deliberately.
That is only honest while the group a chip belongs to is **announced**:

* The card names **each chip list by its own heading** (`aria-labelledby` on the
  `<ul>`, `src/app/p/[slug]/page.tsx`), so a screen reader announces "How I can
  help, list, 1 item" instead of unattached chips. The `<section>` is named too,
  which additionally makes it a `region` landmark.
* `tests/unit/design-tokens.test.ts` pins that wiring and pins that the offers and
  needs headings are **different, non-empty strings in all three locales**, so a
  "cleanup" that strips the attribute or merges the two labels fails a gate
  instead of leaving position as the only difference.
* `tests/e2e/design-gate.spec.ts` asserts it live: the two lists are found **by
  their accessible names**, and the chip texts are disjoint.

## Adding a design direction back

Route the whole change through this document first: a direction is a product
decision, and the recipe below is the entire cost of one. In order:

1. **A token block in `globals.css`.** Append, after the `:root` block:

   ```css
   /* ── <name> — one line on what it is ───────────────────────────────────── */
   html[data-theme="<name>"] {
     /* EVERY token from :root, restated: a missing one leaks a shipped value
        into the direction, and the unit test below fails on it. */
     --t-canvas: #…;
     /* …all 25 of them… */
   }
   ```

   `:root` stays the shipped design and keeps `html[data-theme="<name>"]` free of
   it — the pair for the default is not written twice.

2. **A type entry and the primitives** — recreate `src/lib/theme.ts`:

   ```ts
   export type Theme = 'soft' | '<name>';
   export const THEMES: readonly Theme[] = ['soft', '<name>'];
   export const DEFAULT_THEME: Theme = 'soft';
   export const THEME_COOKIE = 'welcome_theme';
   export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
   export const THEME_QUERY_PARAM = 'theme';
   export function isTheme(value: unknown): value is Theme { … }
   export function resolveRequestTheme(query, cookie): Theme | null {
     if (isTheme(query)) return query;
     return isTheme(cookie) ? cookie : null;   // `null` = "no explicit theme"
   }
   ```

   The `null` return is the important half: "no explicit theme" is a real state —
   the page a stranger gets — and it must stay distinguishable from "soft".

3. **The request plumbing**, four places, wired exactly like `?lang=`:

   * `src/proxy.ts` — read `?theme=`, `request.cookies.set(THEME_COOKIE, …)` for
     the current render, forward `x-welcome-theme`, and `Set-Cookie` on the
     response for the next visit. Keep it scoped to the same four public entry
     points as `?lang=` (`/`, `/login`, `/p/*`, `/legal/*`): `/e/<slug>` and the
     cabinet are reached with the cookie the query just set, so a stray query
     parameter still cannot reshape a signed-in surface. The proxy must stay free
     of account state (pinned structurally in tests/unit/locale-query.test.ts).
   * `src/lib/theme-page.ts` — `getTheme()`, reading the header before the cookie
     (no `cache()`: the layout is the only caller).
   * `src/app/layout.tsx` — `<html data-theme={theme ?? undefined}>`, i.e. **no
     attribute at all** when no theme is explicit, plus the bar.
   * `src/app/api/theme/route.ts` — the only cookie writer: `POST { theme }` sets
     it, `POST { theme: null }` clears it. No consent event, no audit row, no
     `accounts.theme` column (a direction is an hour of review, not a preference).

4. **A review bar** — recreate `src/components/theme-bar.tsx`. Two properties are
   not cosmetic and were learned the hard way:
   * it renders **in flow at the END of the document**, never `fixed`/`sticky`:
     the card's and the event's primary actions are the last thing in their cards,
     so a bottom-anchored bar would cover exactly what is being reviewed;
   * switching **drops the `?theme=` query** on reload (`location.replace` on a URL
     with the parameter removed), because the query outranks the cookie — keeping
     it makes the switcher look broken and "exit" re-enter review mode.

5. **Dictionary keys** in all three locales (`theme.*` — bar title, group label,
   option template, hint, exit, one name per direction) and the parity test stays
   green: `tests/unit/i18n-dictionaries.test.ts` fails on a key present in only one
   locale, in either direction.

6. **The gates**: `tests/unit/design-tokens.test.ts` gains the direction in its
   contrast loop automatically (it iterates the token blocks), and
   `tests/e2e/design-gate.spec.ts` is where a per-direction sweep belongs — iterate
   `THEMES` imported from `src/lib/theme.ts` (never a local copy) and hold each pass
   to axe-at-every-impact, overflow at 390/360 and the 44px rule.

## Decisions that remain true

1. **Tokens, not a stylesheet per page.** One markup, one token layer — a
   direction changes values, never structure. Nothing in the product forks markup
   per look.
2. **A design direction is a review mode, not a preference.** There is no
   `accounts.theme` column and there will not be: a language is what a person says
   about themselves and belongs on the account (`accounts.locale`, migration 014);
   a direction is something one person is doing for an hour and must not follow
   them into someone else's session on a shared device.
3. **No explicit direction → no attribute.** This is the reasoning the plumbing
   above is built on, and it is what keeps a stranger's page identical to the
   shipped one.
4. **`data-theme` belongs on `<html>`.** The token sets hang off the document
   element, so the cabinet inherits colours, radii and weights automatically. The
   cabinet gets **no direction-specific layout** — that is deliberate (see below),
   not an oversight.
5. **A direction may not use colour as its only carrier.** A monochrome direction
   fails the same bar as one that leans on hue, and one that leans on position
   fails it too — hence the named chip lists.

## Not styled — deliberately undesigned

Parts of the app the token layer does **not** reach, so nobody mistakes them for
forgotten work:

1. **Cabinet layout.** `/me/*`, `/organizer/*` inherit colours, radii, weights and
   the card's border width, but keep their own structure and spacing.
2. **Arbitrary-value decoration.** `rounded-[36px]`/`rounded-[48px]` (the landing
   page's mock phone and hero shapes) and `shadow-xl` on that mock are literal
   values in the markup, outside the radius/shadow token scale.
3. **The input placeholder** (`#9aa69c` on white) measures **2.53:1** — below AA,
   as it always has. It is not body text, axe does not read `::placeholder`, and
   changing it would restyle the default page. Recorded rather than silently
   changed.
4. **The control boundaries** (`--t-line-strong` / `--t-field-line` at 1.85:1 /
   1.68:1): recorded and pinned, not raised — see "Measured contrast".
5. **Status colours outside the token set** — `text-red-700` for field errors, and
   any Tailwind palette utility used directly in markup. They are semantic (error),
   not decorative.
6. **The card's compact share strip** (`.btn-small`, 36px tall; the smallest link
   measures 34×36). It is the documented density variant — the same one the cabinet
   and the organizer console use — and on the public card the share row is a
   secondary "pass me on" affordance rather than the page's action, so it is the one
   control set exempt from the 44px floor. It is not exempt from measurement: the
   design gate records all five controls every run and asserts the bar that does
   apply to them (24×24, WCAG 2.5.8 AA, which they clear). Raising the row to 44px
   changes the card's own layout — its height and its line breaks — so it is the
   owner's call, not a side effect of a gate.
7. **The printable badge sheet** (`/organizer/events/[id]/badges`) is plain CSS for
   A4 paper and is not part of the screen design.
8. **Content.** The tokens change no copy, no field, no consent text — only how the
   same information looks.

### Known gap, recorded rather than closed

The card's **language pills** (`en`, `ru`, …) are a `<ul>` with no heading, so they
have no accessible name — nothing above them says "Languages". This is not a
colour-versus-position problem (they are not confused with the taxonomy chips), it
needs a new string in three dictionaries, and it belongs with a broader pass on the
card's list semantics rather than with the design work. Noted here so it is a known
gap and not an unnoticed one.

## Verified, with the numbers

Two viewports — **390×844** (iPhone 14 class) and **360×740** (common small
Android) — landing, legal pages, card, event and the member panel. Full table:
[`evidence/design/measurements.json`](../../evidence/design/measurements.json).

| Check | Result |
|---|---|
| axe, **any impact** | **0 violations** on every surface and viewport, the member panel and the cabinet's membership editor included; the `color-contrast` rule reports **0 nodes** |
| Horizontal overflow | **0px** at both widths on every surface (`scrollWidth === innerWidth`) |
| Primary action above the fold | asserted on the **event** at both widths (the page where the action must be first AND on the first screen); the card's own action is recorded, not asserted — see below |
| Tap targets | ≥44px on every control-shaped element, **and** on the member panel's toggle ROWS and the membership editor's two consent rows (the labels that carry the target, not the 16px boxes inside them). One recorded exception, measured every run: the card's compact share strip (below) |
| AA contrast | asserted from the token values (`tests/unit/design-tokens.test.ts`); table above |
| One design, no selector | `tests/unit/design-tokens.test.ts` walks `src/` and fails if any file contains `data-theme` |
| Token layer intact | the `:root` values are pinned deep-equal, and the `@theme` mapping is asserted to resolve through `var(--t-*)` rather than a literal |
| New runtime dependencies | none |

**The shipped page equals the page that shipped before the token layer existed.**
That claim was measured, not asserted: a capture of the card and the event at 390
in the pre-token build (`HEAD 99b752e`) against the same two elements in the
tokenised build, in one database state (the QR image encodes the slug, so the
fixture must be constant), compared with `cmp`/SHA-256 and no tolerance:

| Surface @390 | Pre-token build | After (tokens, no attribute) |
|---|---|---|
| Card `/p/<slug>` | `59734` B | `59734` B — identical bytes |
| Event `/e/<slug>` | `36927` B | `36927` B — identical bytes |

```
sha256 f5b06a47ac3cc537b6cbce01a0847574c58675072e7338590c273c5991315d25   (card)
sha256 4d78f2201043e5b1a36bf6c87428d657fd8136c14f5ed6e7137ee3b421055fa8   (event)
```

The event digest was reproduced across three separate sessions and two different
database states — the event card has no slug-dependent pixel. Reproducing the
comparison needs the pre-token tree (`git stash`, one capture, restore, repeat,
`cmp`), which is why it is a recorded measurement rather than a standing gate;
what the gate suite asserts instead is the pinned `:root` values themselves, the
computed styles a visitor gets, and the geometry of the primary action.

**First screen, measured (not asserted).** On the gate's own fixture at 390×844
the event ends its primary action at 342 — well inside the first screen, which is
what the hierarchy assertion requires — while the **card** is a different story and
it is a pre-existing one: its action runs 925.875–969.875 and its card ends at
1066.875, so the action sits below the 844px fold. At 360×740 the same holds
(event action ends 378; card action 981.875–1025.875). That is the card being a
long page and the action being its last element, not something the token layer
did: the numbers are in
[`evidence/design/measurements.json`](../../evidence/design/measurements.json) on
every run. Moving that action above the fold means restructuring the card, which
this work deliberately does not do.

## Re-running the evidence

```
pnpm exec playwright test tests/e2e/design-gate.spec.ts      # gates + measurements + screenshots
node --import tsx --test tests/unit/design-tokens.test.ts    # tokens, the single-design pin, AA contrast, chip naming
pnpm gates                                                   # all seven release gates
```

The screenshots and `measurements.json` land in `evidence/design/` and are written
**before** the assertions, so a failing run still leaves the record of what it
measured.

## Not shipped — the three directions, kept as guidance for a future editor

> **Nothing in this section describes the product.** These three value sets were
> compared and rejected; the tokens, files and switches they refer to no longer
> exist. It is kept because almost all of it is about *which kinds of value fail a
> contrast bar and why*, which a future direction will hit again. Read it as a
> worked example, not as a spec.

**`swiss`** — International Typographic Style: a neutral grey ground, black type,
one red accent, grey hairlines, no rounded corner anywhere. Lessons:
its accent kept the shipped coral because the candidate was **measured** at 5.03:1
on white (4.57:1 on the grey ground) and passed, so changing it would have been a
look, not a fix; its canvas was `#f4f4f4` rather than `#ffffff` because at pure
white the `.btn-light` hover (`hover:bg-paper`), the paper-grey language pills
(`!bg-paper !text-muted`) and their border would all have been white on white —
an invisible control, not a style choice; its hairlines were `#888888` (3.54:1 on
white, 3.22:1 on the canvas) so the card frame cleared the 3:1 non-text bar; and
its accent-pale was darkened from a first draft that measured **4.43:1**.

**`poster`** — constructivist poster: a pale ground, near-black type, black rules,
cobalt doing every accent job. Lessons: the cobalt was a true `#0047ab`
(**8.44:1** both ways) rather than a lighter "screen" cobalt, because a brighter
draft of the same hue family loses the white button text fastest and 8.44:1 left
room for the darker hover without re-measuring; the chips were solid cobalt /
near-black with white text instead of pale tints, because a pale tint on a pale
ground is where a "loud" direction turns muddy; and its 2px card rule shifted the
card's bottom edge by 2px, i.e. geometry *is* affected by a border-width token
(which is why the old sweep compared geometry across directions rather than
asserting a shared constant). Three rows of this document were once **stale**
after the palette was lightened in `9c9d0cb` — ink on canvas 17.14 → **18.76:1**,
accent on canvas 7.38 → **8.08:1**, rule width 3px → 2px — which is the reason the
numbers here are now computed by a test from the literals rather than copied by
hand.

**`premium`** — warm monochrome: one warm ramp, hue spent exactly once, all three
chip kinds the same value, hairline seams, a quieter voice. This is the direction
whose requirements shaped the a11y work that remains in the product today
(the named chip lists). Lessons: `--t-muted` was raised from `#6e6c65` to
`#64625b` — the only value in the set that moved for contrast alone — because at
`#6e6c65` the worst pair was 4.52:1, "above 4.5" is the bar a colour has to clear
rather than the bar it should sit on, and a chip-like language pill paints muted
text on the **canvas**, which makes the canvas the binding ground: the shipped
canvas would have to be the deepest warm step at which the muted value still
clears AA. Its boundaries had to clear 3:1 on the **darker** ground (the canvas,
not the white card) — checking only against white is the mistake in reverse. And
its `--t-line` stayed a hairline on purpose (1.44:1): a card seam is not a
control, and the number is recorded rather than hidden by rounding.

The one thing to carry forward from all three: **measure, then decide.** Every
value in this file that changed, changed because a number said so.

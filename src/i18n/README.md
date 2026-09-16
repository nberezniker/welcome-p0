# i18n approach (Phase 4 decision)

- **No heavy dependency.** Three TypeScript dictionaries (`en.ts` master, `ru.ts`/`es.ts` as `Partial<typeof en>`), flat dotted keys, `{var}` interpolation.
- **Locale storage — two layers (durable since migration `014_account_locale.sql`):**
  - **`accounts.locale`** — the language the user chose for their ACCOUNT, written by exactly one thing: the explicit switcher (`POST /api/locale`). `NULL` means "never chose", which is a different fact from `'en'`. This is what makes the choice survive a new device with no cookie, and it is the layer a `?lang=` link may never touch.
  - **`welcome_locale` cookie** (`en|ru|es`) — the DEVICE preference. Set by the same switcher, and additionally by `?lang=` on the public entry points. It is the only input for a visitor who is not signed in.
- **Query override (R1, 2026-09-14):** the public entry points (`/`, `/login`, `/p/*`, `/legal/*`) also accept `?lang=en|ru|es`. `src/proxy.ts` (the Next 16 name for the middleware convention) validates it, forwards `x-welcome-locale` to the current render — so `<html lang>` and the server-rendered strings match the link immediately — and persists it via `Set-Cookie`. An invalid value (`?lang=de`, `?lang=RU`) is ignored and never overwrites a stored preference. **`?lang=` writes the device cookie and the current render, never `accounts.locale`** — a `?lang=` URL is fetched by link unfurlers, chat clients and scanners, and a shared link must not silently change the language of the user's own account.
- **Resolution order (server, `getLocale()`):** a valid forwarded `?lang=` override → `accounts.locale` (valid session only) → valid `welcome_locale` cookie → `en`. The account outranks the cookie on purpose: the account is what the user said about themselves, the cookie is what one device happens to hold.

  | `?lang=` | account | cookie | signed in | result |
  |---|---|---|---|---|
  | — | — | — | no | `en` |
  | — | — | `ru` | no | `ru` |
  | `es` | — | — | no | `es` (this render; cookie set to `es`) |
  | invalid | — | `ru` | no | `ru` (nothing written) |
  | — | `NULL` | — | yes | `en` |
  | — | `NULL` | `ru` | yes | `ru` (pre-014 behaviour, unchanged) |
  | — | `ru` | — | yes | `ru` — the fix: a fresh device follows the account |
  | — | `ru` | `en` | yes | `ru` — the account outvotes a cookie planted elsewhere |
  | `en` | `ru` | — | yes | `en` for that render only; the account stays `ru`, so the cabinet returns to `ru` |
  | any | any | any | yes | `?lang=` NEVER writes `accounts.locale` |

  `Accept-Language` is intentionally not used (predictable, testable; P0 audience switches explicitly). Pure resolver + proxy contract: `tests/unit/locale-query.test.ts`; the switcher/`?lang=` asymmetry and the account column: `tests/integration/locale.test.ts` and `tests/e2e/cabinet-locale.spec.ts`.
- **Fallback:** a missing `ru`/`es` key resolves to the English string at lookup time (`t()` in `src/i18n/index.ts`), so the UI never renders a raw key.
- **Completeness test:** `tests/unit/i18n-dictionaries.test.ts` fails when a key exists in `en` but not in `ru`/`es`, keeping the dictionaries in parity; fallback is the documented escape hatch, not an accident.
- **Client components** receive strings as props from server parents (no dictionary import in client bundles).
- **Boundary rule:** a server module may import only COMPONENTS and types from a `'use client'` module. Next replaces every export of a client module with a client reference in the server graph, so importing data from one hands the server a proxy — `CONSENT_PURPOSES_UI.map is not a function` (the 2026-09-16 `/me/privacy` 500). Plain data belongs in a module of its own on the server side (`src/app/me/privacy/purposes.ts`); `tests/unit/client-boundary.test.ts` fails on any other import shape.
- **Layering:** `src/i18n/locale.ts` holds the dependency-free primitives (codes, cookie name, `isLocale`/`resolveLocale`/`resolveRequestLocale`) so `src/proxy.ts` can import them without pulling the dictionaries or `next/headers` into the proxy bundle; `src/i18n/index.ts` re-exports them for the app and owns the I/O half of resolution (`cookies()`, `headers()`, the session lookup in `src/lib/auth.ts`).

## Known gap (recorded, not fixed here)

Outbound copy — the Phase-4 reminder and weekly digest (`src/domain/followup.ts`) and service notices (`src/domain/service-notices.ts`) — still renders in `DEFAULT_LOCALE`, because the worker does not read `accounts.locale`. The account column introduced by migration 014 now makes a per-account outbound language POSSIBLE; switching the worker over is a behaviour change with its own copy and tests, so it is deliberately left for a separate change. The comments in those modules say so.


# i18n approach (Phase 4 decision)

- **No heavy dependency.** Three TypeScript dictionaries (`en.ts` master, `ru.ts`/`es.ts` as `Partial<typeof en>`), flat dotted keys, `{var}` interpolation.
- **Locale storage:** `welcome_locale` cookie (`en|ru|es`), set by `POST /api/locale { "locale": "ru" }` (HttpOnly=false not needed — server reads it; SameSite=Lax, 1 year, path=/). No URL prefixes — all pages render in the cookie's locale; the switcher posts and calls `router.refresh()`.
- **Resolution order:** cookie value if valid, else `en`. `Accept-Language` is intentionally not used (predictable, testable; P0 audience switches explicitly).
- **Fallback:** a missing `ru`/`es` key resolves to the English string at lookup time (`t()` in `src/i18n/index.ts`), so the UI never renders a raw key.
- **Completeness test:** `tests/unit/i18n-dictionaries.test.ts` fails when a key exists in `en` but not in `ru`/`es`, keeping the dictionaries in parity; fallback is the documented escape hatch, not an accident.
- **Client components** receive strings as props from server parents (no dictionary import in client bundles).

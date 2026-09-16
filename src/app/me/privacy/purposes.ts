/**
 * The consent purposes /me/privacy offers as toggles, and the ORDER they are
 * shown in. Plain data: no browser API, no React, no JSX.
 *
 * WHY THIS IS NOT IN privacy-panel.tsx (defect fix, 2026-09-16): the panel is a
 * `'use client'` module, and Next replaces every export of a client module with
 * a client REFERENCE in the server graph — the object the server page receives
 * is not the array. Importing the list from there made
 * `CONSENT_PURPOSES_UI.map(...)` throw `TypeError: ... is not a function` at
 * render time, so GET /me/privacy answered 500 for every signed-in user while
 * typecheck, lint and the full unit+integration suites stayed green (a client
 * boundary only exists once Next compiles the real graph — hence the e2e
 * regression test, and the static guard in
 * tests/unit/client-boundary.test.ts, which is what keeps the next export from
 * being put on the wrong side of the boundary).
 *
 * The list is deliberately NOT a copy of src/domain/consent.ts CONSENT_PURPOSES:
 * that registry is the closed set the API and the database CHECK accept, while
 * this one is the subset a user may toggle from THIS screen. `digest_weekly`
 * (migration 012) is a real, revocable purpose — it is left out here because its
 * own switch lives next to the mechanic it governs (/me/notes), not because it
 * lacks a dictionary key. `tests/unit/consent-purposes.test.ts` pins the fact
 * that this list is a subset of the registry.
 */
export const CONSENT_PURPOSES_UI = [
  'public_card',
  'event_directory',
  'introduction_fields',
  'service_channel',
  'organizer_marketing',
  'product_marketing',
] as const;

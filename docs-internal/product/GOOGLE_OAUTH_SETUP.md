# WELCOME — Google OAuth setup (owner's 15–20 minutes)

**Status: NOT implemented. Nothing listens on the callback path yet.** This is the exact
checklist for switching Phase 2 of `docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md`
(§D, items 5–6) on. Until the credentials below exist, both Google rows in the provider
registry stay `planned` / `needs_oauth_client` — and `/me/connections` says exactly that
instead of pretending.

## What this unlocks (and what is already available today)

| After the credentials exist | Needs OAuth |
|---|---|
| Google Contacts (People API): import "who of my contacts is already here", push chosen contacts back | **yes** — this document |
| Google Calendar: create the meeting that follows an introduction | **yes** — this document |
| **Import an address book (.vcf / .csv) and see who is already on WELCOME** | **no — live today** |
| Download/export your card as .vcf, events as .ics, participant lists as CSV | **no — live today** |

The last two rows are the reason this document can wait: the address-book import
(`POST /api/me/contacts/import`, card "Import your contacts" on `/me/connections`) already
answers the main question, in memory, with no Google client and no stored contact data.

## Environment variable names — registry names are canonical

Use these two names, exactly:

```
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
```

They come from the provider registry — the single source of truth
(`src/domain/providers.ts`, the `google-contacts` and `google-calendar` rows), which is also
what `/me/connections` prints in the "How to connect" block and what
`tests/unit/providers.test.ts` snapshots.

**Discrepancy with the brief (deliberate, registry wins):** the increment brief named them
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. The registry was written earlier (interop
Phase 1) and already declares `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`, and
it is the only place the UI and the tests read names from. Inventing a second pair would
give the deployment two spellings for one secret and one of them would silently stay unset.
If you prefer the shorter names, the change is one line in each of the two registry rows
plus the snapshot in `tests/unit/providers.test.ts` — say so and it is a five-minute commit;
nothing else reads the names.

## Steps (Google Cloud Console)

1. **Project.** <https://console.cloud.google.com/> → create a project (e.g. `welcome-p0`)
   or pick an existing one. Note the project id — it is not a secret, but keep the values in
   this step out of chat, tickets and logs.
2. **OAuth consent screen.** APIs & Services → *OAuth consent screen*:
   - User type: **External**.
   - Publishing status: **Testing** (that is enough for a pilot; no verification review is
     needed while the app stays in testing, at the cost of a 100-user cap and test users
     having to be listed).
   - App name: **WELCOME**; user support email: your own address; developer contact: your own
     address.
   - **Scopes** → Add or remove scopes → add exactly these two:
     - `https://www.googleapis.com/auth/contacts.readonly`
     - `https://www.googleapis.com/auth/calendar.events`
     Do not add Gmail, Drive or `contacts` (read-write) scopes: the product reads a contact
     list and writes calendar events, nothing else.
   - **Test users** → add your own Google account (mandatory while the app is in testing).
3. **OAuth client.** APIs & Services → *Credentials* → **Create credentials** → **OAuth client
   ID** → Application type **Web application**; name it `welcome-web`.
   **Authorized redirect URIs** (add both, exactly, no trailing slash):
   ```
   https://welcome-p0-nikiti4.vercel.app/api/oauth/google/callback
   http://localhost:3000/api/oauth/google/callback
   ```
   Authorized JavaScript origins are **not** needed — no browser-side Google SDK is used.
   Copy **Client ID** and **Client secret** (the secret is shown once).
4. **Set the variables.** Vercel → the `welcome-p0` project → Settings → Environment
   Variables → add both names above (Production + Preview; a local `.env.local` gets the same
   pair for development). Values are secrets: never commit them, never paste them into chat,
   never put them in an issue. `pnpm scan:secrets` is the gate that fails the build if one
   ever lands in a tracked file.
5. **Tell the agent / owner channel that the variables are set** (names only). At that point
   the implementation work — OAuth start/callback routes, token storage (server-side,
   encrypted), People API and Calendar calls, the
   `/api/oauth/google/callback` handler — is a normal increment against a working client.
6. **Verify after implementation** (nothing to verify today):
   - `/me/connections` → the two Google cards flip from *Coming soon* to *Available* and lose
     the `needs_oauth_client` reason;
   - `GET /api/providers` reports `status: "live"` for `google-contacts` / `google-calendar`
     (their live status is env-derived, like Telegram's);
   - an import from Google Contacts returns the same shape as the address-book import:
     names, slugs, headlines — never addresses;
   - calendar creation from an introduction lands in the tester's own calendar.

## What will NOT change when the credentials exist

- **No scraping, no bulk enrichment.** Only the official People/Calendar APIs, only for the
  account that consented, only with the two scopes above (interop §A1.2).
- **Tokens stay server-side**, encrypted, never in the browser and never in logs; the OAuth
  client secret is never sent to the client.
- **The address book still leaves no trace.** The Google path will reuse the same rule as the
  .vcf/.csv import: match in memory, return names — no stored contact list (interop §C).

## Rotation / revocation

Delete the OAuth client in the Console → the two variables stop working (the cards fall back
to `needs_oauth_client`), then create a new client and repeat step 4. Revoking a user's access
happens on the user's Google account page (<https://myaccount.google.com/permissions>); stored
tokens must be deleted with the account-deletion flow, which is already implemented.

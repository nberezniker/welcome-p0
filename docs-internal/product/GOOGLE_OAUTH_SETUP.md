# WELCOME — Google OAuth setup and operation

**Status: IMPLEMENTED (Phase 2).** The OAuth client exists and the flow is live; what
remains is applying the migration and (per deployment) checking that the two variables
are present. This document is now both the record of what was provisioned and the
runbook for operating the two Google providers.

Phase 2 of [`SOCIAL_INTEROP_AND_MATCHING.md`](SOCIAL_INTEROP_AND_MATCHING.md) §D items 5–6:
Google Contacts (People API) and Google Calendar.

---

## 1. The provisioned client (what actually exists)

| | |
|---|---|
| Google Cloud project | **`my-project-48009welcome-p0`** |
| OAuth client | **`welcome-web`** — application type *Web application* |
| Consent screen | app name **WELCOME**, user type *External*, publishing status *Testing* |
| Scopes on the consent screen | `.../auth/contacts.readonly` and `.../auth/calendar.events` |
| APIs enabled in the project | People API (`people.googleapis.com`), Calendar API (`calendar.json`) |

**Authorized redirect URIs — exactly these two, no trailing slash:**

```
https://welcome.colmogravity.net/api/oauth/google/callback
http://localhost:3000/api/oauth/google/callback
```

The path is `/api/oauth/google/callback` and it is spelled in exactly one place in the
code: `GOOGLE_REDIRECT_PATH` in [`src/domain/google-oauth.ts`](../../src/domain/google-oauth.ts).
Both the `start` route (which sends it as `redirect_uri`) and the `callback` route (which
sends it to the token endpoint) derive it from that constant through
`googleRedirectUri(appBaseUrl())`, because those two values must be byte-identical to each
other and to what Google has registered. A deployment whose `APP_BASE_URL` does not match a
registered URI gets Google's `redirect_uri_mismatch` — and that is the only symptom, which
is why this paragraph exists.

## 2. Environment variable names — registry names are canonical

```
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
```

They come from the provider registry — the single source of truth
(`src/domain/providers.ts`, the `google-contacts` and `google-calendar` rows), which is also
what `/me/connections` prints in the "How to connect" block and what
`tests/unit/providers.test.ts` snapshots. Both rows share the same pair of variables because
they share one OAuth client; `REQUIRED_ENV` lists each row against both names.

Both variables are set in the deployment environment for **production and preview**. Values
are secrets: never committed, never pasted into chat, never put in an issue.
`pnpm scan:secrets` is the gate that fails the build if one lands in a tracked file.

## 3. Deployment order — the migration MUST go first

`db/migrations/013_oauth_grants.sql` creates the two tables the flow depends on
(`oauth_grants`, `oauth_flow_states`). **Apply migration 013 before deploying the code that
uses it.** The code fails closed without it — `start` and `callback` answer with an honest
`unavailable` flag and a logged error rather than storing anything — so the failure mode of
the wrong order is a broken feature, not a corrupt one. Still: apply the migration first.

```
pnpm db:migrate     # applies 013 on top of 012; additive, no existing table is touched
```

## 4. What the flow does

1. **Connect** (`GET /api/oauth/google/start?provider=…`) — requires a session; builds the
   authorization URL with `access_type=offline`, `prompt=consent`, PKCE (`S256`) and a
   signed, single-use state that records the provider. **No Google call is made here**:
   nothing is fetched from Google until the user presses Connect.
2. **Consent** — the browser goes to Google. The scopes requested are only the two above,
   per provider (`contacts.readonly` for contacts, `calendar.events` for the calendar).
3. **Callback** (`GET /api/oauth/google/callback`) — verifies the state's signature, shape
   and expiry, requires the live session to match the account the state was issued to,
   claims the flow's `jti` with a single conditional UPDATE (single use), exchanges the code
   with the PKCE verifier that never left the server, checks the granted scopes cover what
   the provider needs, and stores the tokens **encrypted** (AES-256-GCM, `ENCRYPTION_KEY`).
   Every failure — including an unexpected one — is a redirect to `/me/connections` with a
   status word, never a 500.
4. **Use** — `POST /api/me/contacts/google` reads `people/me/connections` with
   `personFields=names,emailAddresses` and matches in memory; `POST /api/me/calendar/google`
   writes one event into the user's own calendar.
5. **Disconnect** (`DELETE /api/me/oauth/google?provider=…`) — **deletes our row first**, then
   asks Google to revoke the token best-effort, and reports both facts separately.

## 5. What will NOT happen (unchanged, and now enforced by code)

- **No scraping, no bulk enrichment.** Only the official People/Calendar APIs, only for the
  account that consented, only with the two scopes above (interop §A1.2).
- **Tokens stay server-side**, encrypted, never in the browser and never in logs. The routes
  project a grant as a *state word* (`connected` / `expired` / `revoked` / `not_connected`),
  never as a value.
- **An imported address book still leaves no trace.** A Google contact list is read into
  memory, matched by peppered HMAC and discarded — the same code path as the .vcf/.csv import
  (`src/domain/contact-match.ts`). Nothing from it is stored, not even a hash.
  `tests/integration/google-oauth.test.ts` proves the absence by scanning every table.
- **The counterpart's email is not sent to Google** unless the user explicitly opts in on
  that action. `googleCalendarAttendees()` is the only producer of an attendee list and
  returns `[]` by default; supplying an address without the opt-in is a `400`, never a
  silent drop.

## 6. Capabilities — narrowed to what this client can grant

The §A3 table listed both Google rows as `import, export`. The provisioned client is scoped
`contacts.readonly` + `calendar.events`, which makes two halves impossible:

| Row | §A3 said | Registered now | Why |
|---|---|---|---|
| Google Contacts | `import, export` (`both`) | `import, match` (`in`) | "push chosen contacts back" needs the read-**write** `contacts` scope |
| Google Calendar | `import, export` (`both`) | `export` (`out`) | reading the user's calendar needs `calendar.readonly` |

A `live` row claiming a capability the client cannot grant would be a false statement in the
UI ("What it can do") — the exact kind of pretending the registry exists to prevent. Adding
either half back means adding the scope on the consent screen, not changing code; re-widen
`capabilities` in `src/domain/providers.ts` and update the snapshot in
`tests/unit/providers.test.ts` in the same commit.

## 7. States on `/me/connections`

Two independent truths are shown, and neither is inferred from the other:

| | Meaning |
|---|---|
| **instance** = `not configured` | this deployment has no `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`; the card names both variables and offers no connect control |
| **instance** = `Available` | the client is configured; the per-user state below applies |
| `Not connected` | no grant for this account |
| `Connected` | a usable grant with the required scope |
| `Expired — connect again` | the token expired with nothing to renew it, a renewal already failed, or Google granted fewer scopes than the provider needs |
| `Access revoked at Google` | Google answered `invalid_grant` to a refresh: the user removed access on their Google account page. Recorded, not silently retried |

The state is **derived from facts** (`googleGrantState`, `src/domain/google-oauth.ts`), not
stored in a column that could drift away from what the tokens actually are.

## 8. Revocation and rotation

- **A user revoking access at Google** (`https://myaccount.google.com/permissions`): the next
  call refreshes, Google answers `invalid_grant`, and the grant is stamped revoked with that
  reason. The card says so and offers "Connect again". Nothing else breaks.
- **A user disconnecting in WELCOME**: the grant row is hard-deleted and Google is asked to
  revoke. A failed revoke is reported (`revoked_at_google: false`) without undoing the
  disconnect.
- **Deleting an account**: `oauth_grants` and `oauth_flow_states` both cascade from
  `accounts(id)`, so the account-deletion flow already erases the tokens.
- **Rotating the OAuth client**: delete the client in the Console → both variables stop
  working → the two cards fall back to *not configured* with `not_configured` +
  `missing_env`. Create a new client, set the variables, re-add both redirect URIs, done.
  Existing grants become unusable (the client is gone) and the next Connect replaces them.
- **Rotating `ENCRYPTION_KEY`**: stored tokens become undecryptable and are treated as
  absent — the honest outcome is "connect again", never a crash and never a wrong token.

## 9. Verification checklist

- `/me/connections` → the two Google cards are **Available**, and each shows a per-user state
  (`Not connected` on a fresh account) plus what is read and what is written.
- `GET /api/providers` reports `status: "live"` for `google-contacts` / `google-calendar`,
  with `missing_env: []` when the pair is set and
  `missing_env: ["GOOGLE_OAUTH_CLIENT_ID","GOOGLE_OAUTH_CLIENT_SECRET"]` when it is not.
- Pressing Connect reaches Google's consent screen and comes back with
  `?google=…&status=connected`; a cancelled consent comes back with `status=denied`.
- "See who is already here" returns the same shape as the address-book import: names, slugs
  and headlines — never addresses.
- A meeting created through `POST /api/me/calendar/google` lands in the tester's own calendar
  and shows the counterpart as a name.

## 10. Owner's original 15-minute checklist (kept for re-provisioning)

1. **Project.** <https://console.cloud.google.com/> → create a project (`my-project-48009welcome-p0`)
   or pick an existing one.
2. **OAuth consent screen.** APIs & Services → *OAuth consent screen*: user type **External**,
   publishing status **Testing** (a 100-user cap; every tester must be listed as a test user),
   app name **WELCOME**, your own support and developer contact addresses, and exactly the two
   scopes:
   - `https://www.googleapis.com/auth/contacts.readonly`
   - `https://www.googleapis.com/auth/calendar.events`

   Do not add Gmail, Drive or `contacts` (read-write): the product reads a contact list and
   writes calendar events, nothing else.
3. **OAuth client.** APIs & Services → *Credentials* → **Create credentials** → **OAuth client
   ID** → **Web application**, name `welcome-web`, and the two redirect URIs from §1.
   Authorized JavaScript origins are **not** needed — there is no browser-side Google SDK.
4. **Set the variables** (§2) for Production + Preview, and in a local `.env.local`.
5. **Apply migration 013 before deploying the code** (§3).
6. Run the checklist in §9.

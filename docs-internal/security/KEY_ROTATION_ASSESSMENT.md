# `ENCRYPTION_KEY` rotation — assessment

**Status: assessed, deliberately NOT implemented.** No keyring, no format change,
no script. This note exists so the decision is a decision rather than an absence,
and so the next person does not have to re-derive the surface from greps. It is
cross-referenced from the two places that currently state the limitation in one
line — the *Known limitations* entry in [`SECURITY.md`](../../SECURITY.md) and the
`ENCRYPTION_KEY` note in §3.3 of [`SELF_HOSTING.md`](../../SELF_HOSTING.md).

## What the key actually does today

One env var, one AES-256-GCM key, **two roles**. The second one is the easy one to
miss, because it is not a column:

**1. AEAD for stored secrets** — `encryptValue` / `decryptValue`
([`src/lib/crypto.ts`](../../src/lib/crypto.ts)), payload
`v1.<iv b64>.<ciphertext b64>.<tag b64>`, random 12-byte IV per value. Six
columns, five tables:

| Table | Column | What it holds |
|---|---|---|
| `contact_fields` | `encrypted_value` | every contact value (whatsapp, phone, links…) |
| `registrations` | `encrypted_email` | registrant email imported from a CSV |
| `mfa_factors` | `secret_encrypted` | the TOTP shared secret |
| `oauth_grants` | `access_token_encrypted` | Google access token |
| `oauth_grants` | `refresh_token_encrypted` | Google refresh token (nullable) |
| `oauth_flow_states` | `code_verifier_encrypted` | PKCE code verifier |

**2. A MAC key for the OAuth `state`**, derived from the same key with HKDF and a
distinct `info` string ([`src/lib/oauth-state.ts`](../../src/lib/oauth-state.ts)).
That state has a **10-minute TTL** and is used exactly once, on the Google
callback.

Everything reads through one function: **ten `decryptValue` call sites** across
nine modules; eight `encryptValue` call sites. So the fan-in that makes this
tractable is real — key *selection* is a single function — and the OAuth state is
the one consumer that does not go through it.

## Why rotation is impossible as the code stands

`decryptValue` requires the first segment to be exactly `VALUE_PREFIX` (`'v1'`)
and reads the single env key. A payload encrypted under a second key is not
"readable with the wrong key" — it is **rejected as malformed** before the key is
ever consulted. There is no key id to select on, and exactly one key to select.
Consequence, stated plainly: the key is a one-way door. Lost → the data it
encrypts is lost. Leaked → there is no remedy except deleting that data.

## What a rotation would require

### a) Storage: a keyring, and an id inside the payload

- **Put the key id in the version slot**, e.g. `<key-id>.<iv>.<ct>.<tag>`, with
  today's `v1` payloads read as id `v1`. **No schema migration is needed for
  this**: nothing in `db/migrations/` constrains the payload format — the only
  mentions of `v1.…` in SQL are comments (verified). A new id is therefore a
  code-and-env change, not a DDL change.
- Env: `ENCRYPTION_KEYS="<id>:<base64>,<id>:<base64>"` plus `ENCRYPTION_KEY_ID`
  naming the active key. Keep `ENCRYPTION_KEY` accepted as the single-key
  shorthand (id `v1`) so every existing deployment, `.env.example` and the e2e
  fixtures keep booting without edits — `ENCRYPTION_KEY` stays REQUIRED; the
  keyring is the optional superset.
- If the tables ever grow past a scan-friendly size, the alternative is a
  `key_id` column with a partial index, at the cost of a migration *and* the
  expand/contract discipline below. The payload slot avoids both; the trade is
  that "which rows are still on the old key" becomes a `LIKE '<old-id>.%'` scan
  rather than an index lookup.

### b) The decryption path

Unchanged in shape for the six columns: `decryptValue` parses the id, selects the
key, decrypts. A missing id is a hard error naming the id — never a silent
fallback to the active key, which would turn a rotation mistake into quietly
garbage data.

The two extra considerations:

- **The OAuth-state MAC** needs the same treatment (carry the key id in the signed
  payload). Without it, flipping the active key invalidates states issued in the
  previous 10 minutes. That is survivable — the user is mid-redirect and the
  failure is "start again", not lost data — but it must be a **stated** choice,
  because it is the one place where rotation is briefly user-visible.
- **In-flight work**: the worker decrypts a contact value when choosing a channel
  ([`src/infra/recipient-channel.ts`](../../src/infra/recipient-channel.ts)), so a
  key that cannot decrypt a value surfaces as a job that fails and requeues under
  the existing unknown-cap, not as a crash loop. Worth asserting in the runbook.

### c) The re-encryption job

`scripts/rotate-encryption-key.mts`, following the house pattern already set by
[`scripts/migrate-tags-to-v3.mts`](../../scripts/migrate-tags-to-v3.mts):
**idempotent, deterministic, `--dry-run`, refuses `APP_ENV=production` without an
explicit flag.** It walks the six columns in batches by primary key, selecting only
rows whose payload still carries the old id, decrypts with that id, re-encrypts
under the active key, and updates. Batch + short transactions, and no long-running
transaction anywhere. Resumability is free: a second run finds nothing left on the
old key and writes nothing, so an interrupted run is just re-run.

Its **output is the verification** for the last step: a per-column count of rows
by key id, which must read *zero rows on the old key* before anyone retires it.

### d) Migration order for a live deployment (expand → flip → backfill → contract)

1. **Expand.** Deploy code that reads every key in the keyring and writes the
   active key's id explicitly, with **active = the OLD key**. Nothing about
   stored data changes here; this step exists solely so that step 2 cannot write
   an id that no reader understands.
2. **Flip.** Set `ENCRYPTION_KEY_ID` to the NEW key. New writes use it; old rows
   remain readable because the old key is still in the keyring.
3. **Backfill.** Run the job until the dry-run count of rows on the old key is
   zero, then run it for real. Steps 2 and 3 can overlap: step 3 only ever touches
   rows on the old key, and the job re-reads before each update.
4. **Contract.** Remove the old key from the keyring — a deliberate act, with its
   own backup note (see Backup coupling below).

Ordering constraints, each for a specific failure: **1 before 2** (otherwise new
payloads carry an id no reader knows, i.e. unreadable data); **3 before 4**
(otherwise the rows still on the old key become permanently unreadable). Steps 1
and 2 are reversible by changing the env back at any point before step 4; after
step 3 nothing is on the old key, so reverting is only a matter of the in-flight
OAuth states.

If a `key_id` column is chosen over the payload slot, that migration lands in
step 1 — the same expand/contract order, just with DDL at the front.

## Risks

- **Silent unreadable data is the failure mode to design against.** A wrong id or
  a missing key makes `decryptValue` throw at the use site (a 500 on the contacts
  list, the intro reveal, the export; a requeued job in the worker). Mitigations:
  the per-key-id row counts above, and a canary read of one row per column per key
  id after each step.
- **The OAuth MAC is the blind spot** for anyone auditing "what is encrypted" by
  looking for ciphertext columns. It is a derived MAC key, not a ciphertext. Any
  rotation plan that only lists six columns is incomplete.
- **Partial rotation is a normal intermediate state, not a fault** — mixed-key
  data is exactly what steps 2–3 produce. The design has to make that state
  *readable* (it does: selection is per-payload) rather than trying to make the
  rotation atomic.
- **A refresh token that cannot be decrypted is a grant the user must reconnect.**
  Bounded and visible in the UI as revoked, not silent — but a rotation performed
  while a grant is mid-refresh is worth avoiding.
- **Key ordering / paste mistakes.** Two base64 keys swapped in the env is the
  obvious operator error. Because the id is explicit and per-payload, it presents
  as "no key with id `<x>`", which is diagnosable, rather than as data that
  decrypts to garbage.
- **Backup coupling.** For the whole rotation window both keys must be backed up
  with the database. Retiring the old key is therefore a backup-policy event, not
  just an env edit.

## Rough sizing

| Piece | Effort |
|---|---|
| Keyring env + payload key id + `decryptValue` selection + unit tests | 0.5–1 day |
| OAuth-state key id + tests | ~0.5 day |
| `rotate-encryption-key.mts` (batch, dry-run, counts) + tests + docs | 1–1.5 days |
| Live-rotation runbook (order, verification counts, rollback) | ~0.5 day |
| **Total** | **~2.5–3.5 days** |

Not a P0 item, and nothing here is urgent while the key belongs to one operator
and its loss costs only re-created data. It becomes worth doing the moment the key
is shared, escrowed, or belongs to someone other than the person who can accept
the data loss.

## Deliberately not done in this pass

No keyring, no payload-format change, no rotation script — the assessment only. The
limitation statements in `SECURITY.md` and `SELF_HOSTING.md` remain accurate as
written; both now point here for the reasons and the shape.

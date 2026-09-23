# `ENCRYPTION_KEY` rotation — assessment

**Status: phase 1 implemented; one decision deliberately left open.**

* **Implemented** — the keyring, the key id inside every payload, and the
  maintenance command that moves rows onto the active key
  (`src/lib/crypto.ts`, `src/domain/key-rotation.ts`,
  `scripts/rotate-encryption-key.mts`, `pnpm key:rotate`). A deployment that sets
  no new variable behaves exactly as before; see *What phase 1 delivered*.
* **Left open on purpose** — the OAuth `state` MAC still derives its key from
  `ENCRYPTION_KEY` **alone**, so flipping that variable invalidates states issued
  in the previous ten minutes. Both options and their costs are in
  *The OAuth-state MAC* below. This is a decision for the person performing the
  flip, so phase 1 touched no line of `src/lib/oauth-state.ts`.
* **Procedure** — the expand → flip → backfill → contract order, the verification
  counts and the rollback live in
  [`docs-internal/ops/RUNBOOK.md` §5](../ops/RUNBOOK.md). This note is the *why*;
  that one is the *do*.

It is cross-referenced from the *Known limitations* entry in
[`SECURITY.md`](../../SECURITY.md) and the `ENCRYPTION_KEY` note in §3.3 of
[`SELF_HOSTING.md`](../../SELF_HOSTING.md).

## What the key actually does today

One env var, one AES-256-GCM key, **two roles**. The second one is the easy one to
miss, because it is not a column:

**1. AEAD for stored secrets** — `encryptStored` / `decryptStored`
([`src/lib/crypto.ts`](../../src/lib/crypto.ts)), payload
`<key-id>.<iv b64>.<ciphertext b64>.<tag b64>`, random 12-byte IV per value. Six
columns, five tables — this is `ENCRYPTED_COLUMNS` in
[`src/domain/key-rotation.ts`](../../src/domain/key-rotation.ts), and
`tests/integration/encrypted-columns.test.ts` checks that registry against
`information_schema` in both directions (every declared column exists; no column
holding ciphertext is missing from it):

| Table | Column | Primary key | What it holds |
|---|---|---|---|
| `contact_fields` | `encrypted_value` | `id` | every contact value (whatsapp, phone, links…) |
| `registrations` | `encrypted_email` | `id` | registrant email imported from a CSV (nullable) |
| `mfa_credentials` | `secret_encrypted` | `account_id` | the TOTP shared secret |
| `oauth_grants` | `access_token_encrypted` | `id` | Google access token |
| `oauth_grants` | `refresh_token_encrypted` | `id` | Google refresh token (nullable) |
| `oauth_flow_states` | `code_verifier_encrypted` | `jti` | PKCE code verifier of an in-flight flow |

Two of those tables do not have an `id`: the TOTP credential is keyed by
`account_id` (one row per account) and a flow state by `jti` (a random 128-bit
id). The command takes the identity from the registry rather than assuming one,
which is what the primary-key column is for.

**2. A MAC key for the OAuth `state`**, derived from the same key with HKDF and a
distinct `info` string ([`src/lib/oauth-state.ts`](../../src/lib/oauth-state.ts)).
That state has a **10-minute TTL** and is used exactly once, on the Google
callback.

Everything that reads or writes a stored secret now goes through
`encryptStored` / `decryptStored`: **eight write sites and ten read sites across
eleven modules**, so the fan-in that makes this tractable is real — key
*selection* is a single function. The one consumer that does not go through it is
the OAuth state, and that is a decision, not an oversight.

## Why rotation was impossible before

`decryptValue` required the first segment to be exactly `v1` and read the single
env key. A payload encrypted under a second key was not "readable with the wrong
key" — it was **rejected as malformed** before the key was ever consulted. There
was no key id to select on, and exactly one key to select. Consequence, stated
plainly: the key was a one-way door. Lost → the data it encrypts is lost. Leaked →
there was no remedy except deleting that data.

## What phase 1 delivered

### a) The id was already in the payload — it just had to be read

The payload's first slot was a version slot that had to equal one hard-coded
constant (`VALUE_PREFIX = 'v1'`). It is now read as a **key id**, and `v1` is the
name of the key every existing payload already carries. So:

* **no schema migration** — nothing in `db/migrations/` constrains the payload
  format (the only `v1.…` mentions in SQL are comments), so this is a code-and-env
  change;
* **no dual parser, no format flag** — there is one way to write a payload and one
  way to read it, and today's bytes are already in the new format;
* **no rewrite of existing rows at deploy time** — with only `ENCRYPTION_KEY` set,
  the keyring holds `{v1}` and the values written are byte-for-byte what was
  written before (pinned by `tests/unit/keyring.test.ts`, including a ciphertext
  produced by the pre-keyring implementation that still decodes).

### b) The keyring: one active key, any number readable

```
ENCRYPTION_KEY      REQUIRED, unchanged — the material of the ACTIVE key (id v1 by default)
ENCRYPTION_KEY_ID   optional — the active key's id, for when it is not v1
ENCRYPTION_KEYS     optional — FURTHER keys this deployment can still READ, as "id:base64,id:base64"
```

Two properties of this shape are the design, not details:

* **The active key's material can never be missing.** It is `ENCRYPTION_KEY`
  itself, so "write under an id whose key we do not have" is not expressible, and
  the active id does not have to be pasted into a second variable where it could
  drift from the first.
* **A rotation never asks for the same secret twice.** The key being moved away
  from is parked in `ENCRYPTION_KEYS` under its own id while `ENCRYPTION_KEY`
  takes the new one.

Every misconfiguration that *is* expressible is a refusal naming what is wrong,
and none of them echoes key material: an unusable id, a duplicate id, a
non-32-byte key, an entry that is not `id:base64`, and — the one worth calling
out — naming the active id again in `ENCRYPTION_KEYS`, which would put two
different keys behind one id and make "which key does this row need?" ambiguous.
The decryption path has the same stance: **a payload whose id is not in the
keyring is a hard error that names the id**, never a silent fallback to the active
key, because a fallback turns a missing key (fixable by restoring the env) into
data that decrypts to garbage.

### c) How rows written before this change are treated

They are read, not rewritten: they carry `v1`, `v1` is in the keyring, so they are
`current` and untouched. They become `stale` — the class the command rewrites —
only once a *different* id is made active, which is a deliberate step
(`ENCRYPTION_KEY_ID`). Nothing rewrites a payload on deploy.

The command's classes are exhaustive, and every row lands in exactly one:

| Class | Condition | Command's action |
|---|---|---|
| `current` | names the active id **and opens under it** | none |
| `stale` | names another id the keyring holds, **and opens under it** | **rewritten** |
| `foreign` | names an id the keyring does not have | none — reported with primary keys |
| `corrupt` | not a payload, or does not open under the id it names | none — reported with primary keys |
| `null` | the column value is NULL (nullable columns only) | none |

Reading every payload — the `current` ones included — is deliberate: it makes
`current` mean "this deployment can read this row" and `stale` mean "proven
re-encryptable", rather than "the id looks acceptable". The case that justifies
the cost: changing `ENCRYPTION_KEY` **without** changing `ENCRYPTION_KEY_ID`, i.e.
keeping the id while swapping the material behind it. Classify by id alone and
every affected row reports as healthy while nothing can read it.

### d) The rotation command

`pnpm key:rotate` ([`scripts/rotate-encryption-key.mts`](../../scripts/rotate-encryption-key.mts)),
following the house pattern of `scripts/migrate-tags-to-v3.mts`:

* **idempotent** — a second run finds nothing stale and writes nothing;
* **batched, one short transaction per batch** (`--batch=N`, default 200), walking
  each column in primary-key order: no long-running transaction anywhere;
* **compare-and-swap per row** (`UPDATE … WHERE pk = … AND col = <the value read>`),
  so a row another writer changed mid-run is left alone and counted, not clobbered;
* **`--dry-run`**, and a production guard: `APP_ENV=production`, a non-local
  database host or an unreadable URL all require `--i-know-this-is-production` —
  the **same flag**, and the same definition of "production-like", as
  `pnpm demo:reset` (`src/domain/production-guard.ts`, shared by both commands);
* **the census is the report and the verification**: per column, per class, the
  counts *and* the primary keys of every row the command will not touch — up to
  `--limit` (default 20, `--limit=0` for all of them), with the remainder and the
  flag that shows it printed in place of the tail. Values are never printed, and
  neither are keys.
* after an apply it censuses again and **fails the run (exit 1)** if any stale row
  remains or if the unreadable count changed.

One honesty detail worth keeping: the completion message does not say "reads zero"
when a retired id is still *named* by a row that cannot be read under it. That is
not stale (there is nothing to rewrite) so the rotation is complete, but the id is
not yet safe to forget, and the report says exactly that with the row count.

## The OAuth-state MAC — the decision still open

This is the one place where a rotation is briefly user-visible, and phase 1
deliberately did not choose.

**Today.** `signOAuthState` / `verifyOAuthState` derive their MAC key with HKDF
from `ENCRYPTION_KEY` ([`src/lib/oauth-state.ts`](../../src/lib/oauth-state.ts)).
It is a derived key, not a ciphertext column, which is why an audit that lists
"the encrypted columns" misses it entirely.

**The consequence if it is left as it is.** `ENCRYPTION_KEY` changes at the flip
step, so every state signed in the **previous ten minutes** (the state TTL) stops
verifying. The user is mid-redirect to or from Google and the failure is
`bad_signature` → "start again". Not lost data, not a security issue: the affected
states are single-use and short-lived, and re-issuing one is a click. It is
strictly a window of failed sign-ins, ten minutes wide, on the deployment that is
rotating.

**Option A — leave it derived from `ENCRYPTION_KEY` (what the code does now).**
The MAC key changes when `ENCRYPTION_KEY` changes, so there is nothing else to
keep in sync, no new field in a browser-visible artifact, and no way to run with a
state key nobody can verify. Cost: the ten-minute window above, once per rotation.
This also means the DERIVED key's lifetime is tied to the active key, so a
deployment that flips back and forth is fine (states are 10 minutes), while a
deployment that keeps both AES keys in the keyring does **not** get two state keys.

**Option B — put the key id in the state, as the payload slot does.**
`state = base64url(payload+keyId).base64url(MAC)`, with the MAC key derived from
the key that id names: states signed under the old key verify for as long as that
key is in the keyring, and the window disappears entirely. Cost: a change to a
browser-visible, security-sensitive artifact (its own version bump, its own tests,
and a period where a state signed by the *previous* build must still be accepted),
plus a second place where key **selection** has to be right. The window it buys
back is ten minutes, once, of sign-ins that fail visibly.

**Where the choice belongs.** With the flip: it only matters at the moment
`ENCRYPTION_KEY` changes, and it is the operator who knows whether a ten-minute
sign-in window is acceptable for that deployment. The runbook's flip step
therefore names it as the one user-visible effect of the step, rather than leaving
it to be discovered.

## Migration order for a live deployment (expand → flip → backfill → contract)

Unchanged from the original assessment, and now executable — the steps, the
commands, the verification counts and the rollback are in
[`docs-internal/ops/RUNBOOK.md` §5](../ops/RUNBOOK.md). The ordering constraints,
each for a specific failure:

1. **Expand** — deploy code that reads the whole keyring and writes the active
   id, with active = the OLD key. Nothing about stored data changes; this step
   exists solely so step 2 cannot write an id no reader understands. (With this
   change already deployed, expand is just setting `ENCRYPTION_KEYS`.)
2. **Flip** — point `ENCRYPTION_KEY` at the new key and `ENCRYPTION_KEY_ID` at its
   id, keeping the old key in `ENCRYPTION_KEYS`. New writes use the new key; old
   rows stay readable because the old key is still in the keyring. *This is the
   step with the OAuth-state window, and the step the decision above belongs to.*
3. **Backfill** — `pnpm key:rotate --dry-run` until it reads zero stale rows, then
   run it for real. Steps 2 and 3 may overlap: the command only ever selects rows
   whose id is a non-active key, and each update is a compare-and-swap.
4. **Contract** — remove the old key from `ENCRYPTION_KEYS`. A deliberate act with
   its own backup consequence (below), taken only when the census reads zero for
   that id.

**1 before 2** (otherwise new payloads carry an id no reader knows, i.e.
unreadable data); **3 before 4** (otherwise the rows still on the old key become
permanently unreadable). Steps 1 and 2 are reversible by changing the env back at
any point before step 4; after step 3 nothing is on the old key, so reverting is
only a matter of in-flight OAuth states.

## Risks

* **Silent unreadable data is the failure mode to design against.** A wrong id or
  a missing key makes decryption throw at the use site (a 500 on the contacts
  list, the intro reveal, the export; a requeued job in the worker). Mitigations:
  the per-key-id counts in the census, the `foreign`/`corrupt` rows named by
  primary key, and the hard error that names the missing id.
* **The OAuth MAC is the blind spot** for anyone auditing "what is encrypted" by
  looking for ciphertext columns. It is a derived MAC key, not a ciphertext. Any
  rotation plan that only lists six columns is incomplete.
* **Partial rotation is a normal intermediate state, not a fault** — mixed-key
  data is exactly what steps 2–3 produce. The design makes that state *readable*
  (selection is per-payload) rather than trying to make the rotation atomic.
* **A refresh token that cannot be decrypted is a grant the user must reconnect.**
  Bounded and visible in the UI as revoked, not silent — but a rotation performed
  while a grant is mid-refresh is worth avoiding.
* **Key ordering / paste mistakes.** Because the id is explicit and per-payload,
  this presents as "no key with id `<x>`", which is diagnosable, rather than as
  data that decrypts to garbage. The one mistake this shape cannot catch is
  changing `ENCRYPTION_KEY` while leaving `ENCRYPTION_KEY_ID` alone — the
  census's read-every-row rule reports those rows, and the runbook names the pair
  that must change together.
* **Backup coupling.** For the whole rotation window both keys must be backed up
  with the database. Retiring the old key is therefore a backup-policy event, not
  just an env edit.
* **Unreadable rows are not fixed by rotating.** A row whose key is gone stays
  unreadable; the command reports it and leaves it exactly as it is. Rewriting it
  would mean inventing a value or dropping the row, and neither is what "rotate a
  key" asks for.
* **`oauth_flow_states` rows are short-lived, and the command still rewrites
  them.** A dead flow state (expired or consumed) has no further use, but leaving
  it on the retired id would make the "zero rows on the old key" verification a
  lie and take the row's ciphertext out of reach for good. Rewriting is the
  conservative choice; deleting is not this command's call to make.

## Sizing, against what actually happened

| Piece | Earlier estimate | Now |
|---|---|---|
| Keyring env + payload key id + selection + unit tests | 0.5–1 day | **done** |
| `rotate-encryption-key.mts` (batch, dry-run, counts, identity) + tests | 1–1.5 days | **done** |
| Schema-vs-registry integration test | not foreseen | **done** (the registry is trusted by the command, so it is checked) |
| OAuth-state key id + tests (Option B) | ~0.5 day | **not started — the open decision above** |
| Live-rotation runbook | ~0.5 day | **done** (§5 of the runbook) |

Not a P0 item, and nothing here is urgent while the key belongs to one operator
and its loss costs only re-created data. It becomes worth doing the moment the key
is shared, escrowed, or belongs to someone other than the person who can accept
the data loss — and from phase 1 on, "worth doing" is a runbook step rather than a
rewrite.

## Deliberately not done in phase 1

The OAuth-state key id (both options above, with their costs), and nothing else
that was in scope: the six columns are covered, the legacy rows are read
unchanged, and the rotation is a command with a dry run rather than a procedure
anyone has to derive. `spec/` and the matching core are untouched, as is every
payload's existing format.

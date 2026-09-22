# Self-hosting WELCOME

`git clone` → a working instance on your own machine, with **none** of the
upstream author's accounts, keys or infrastructure. This document is the whole
walkthrough; [README.md](README.md) has the short version and points here.

Everything below was executed end to end against a fresh clone on 2026-09-17:
local PostgreSQL 16, generated secrets, no external accounts. What was observed
at each step is written as the expected output, because "it should work" is not
evidence.

---

## 1. What runs with zero external accounts

This is the honest starting point. With only the five REQUIRED variables, you get
a fully usable product — and every external channel reports itself as off instead
of pretending:

| Capability | With the minimal setup |
|---|---|
| Email one-time-code sign-in | Works. The code is appended to the gitignored `.runtime/otp.log` instead of being emailed. |
| Profiles, public card `/p/:slug`, QR, vCard | Works fully. |
| Events, joining, directory | Works fully. |
| Introductions and the consent-gated **mutual reveal** | Works fully. |
| Contact import (`vcf` / `csv`), matching, recommendations | Works fully — no OAuth client needed. |
| Organizer funnel, campaigns, badges, exports | Works; outbound notices are **suppressed** with an auditable reason. |
| Telegram channel | **Disabled.** `GET /api/providers` says `disabled` / `not_configured` / `missing_env: ["TELEGRAM_BOT_TOKEN"]`. |
| Email provider (Resend) | **Absent.** Same honest `not_configured`. |
| AI enrichment (Vertex) | **Disabled.** `POST /api/me/enrich` → `503 enrichment_disabled`, `retryable: false`. |
| Google Contacts / Calendar | **Not configured.** Both rows report `not_configured`. |
| Microsoft / GitHub / Luma | `planned` / `disabled` — design states a value cannot flip. |

"Suppressed" is a real outbox outcome, not a silent drop: run the worker and you
will see `suppressed:no_channel` next to each job.

---

## 2. Prerequisites

| Need | Version / note |
|---|---|
| Node.js | **≥ 22** (`.nvmrc` and `engines` pin the floor; every gate runs on 22.x) |
| pnpm | **10.x** (`corepack enable pnpm` is the simplest way) |
| PostgreSQL | **16+**. No extensions required — the schema is plain SQL. |
| A GCP project | **Only** for AI enrichment. Optional. |
| A Resend account | **Only** to send real email. Optional. |
| A Telegram bot | **Only** for the Telegram channel. Optional. |
| A Google Cloud OAuth client | **Only** for Google Contacts/Calendar. Optional. |
| A domain | **Only** for a public HTTPS deployment. Optional — `localhost` works. |

No account on any service is required to run the app.

---

## 3. Quickstart

Every command is run from the repository root.

> **Prefer containers?** §4.7 runs the app, PostgreSQL and the migrations with
> `docker compose up -d --build`, no Node or pnpm on the host. This section is the
> manual path, and it is the one to follow if you want to read what each step does
> before it happens.

### 3.1 Install

```bash
pnpm install
```

### 3.2 Create the database

```bash
createdb welcome_dev
```

Any PostgreSQL 16+ you can reach works: a local server, Docker, or a managed
one (Neon, Supabase, RDS…). For a managed database append `?sslmode=require` to
the connection string.

### 3.3 Create your environment file

```bash
cp .env.example .env.local
```

`.env.local` is gitignored. [.env.example](.env.example) documents **every**
variable the code reads, each labelled `REQUIRED` or `OPTIONAL (<feature>)` — a
unit test (`tests/unit/env-example-coverage.test.ts`) fails the build if the two
ever drift apart.

Generate the two secrets; do not invent them by hand:

```bash
openssl rand -base64 32   # → ENCRYPTION_KEY   (must decode to exactly 32 bytes)
openssl rand -base64 24   # → HASH_PEPPER
```

Set at least:

```ini
APP_ENV=development
APP_BASE_URL=http://localhost:3000
DATABASE_URL=postgres://localhost:5432/welcome_dev
ENCRYPTION_KEY=<paste the 32-byte base64>
HASH_PEPPER=<paste the random pepper>
```

> **`ENCRYPTION_KEY` is not rotatable.** It is the AES-256-GCM key for contact
> fields at rest. Lose it and existing contacts cannot be decrypted. Back it up
> the way you back up the database. It is one key for everything the app
> encrypts — contacts, imported emails, TOTP secrets, OAuth code verifiers and
> Google grant tokens — and no rotation path exists: the *Known limitations*
> entry in [SECURITY.md](SECURITY.md) says what a keyring would take, and
> [docs-internal/security/KEY_ROTATION_ASSESSMENT.md](docs-internal/security/KEY_ROTATION_ASSESSMENT.md)
> works it out in full (including the ordering a live rotation would need and why
> the OAuth `state` is the part everyone forgets). Choose it as though it were
> permanent, because today it is.

### 3.4 Apply the migrations

```bash
pnpm db:migrate
```

Plain SQL files in `db/migrations/`, applied in order and recorded in
`schema_migrations`. Safe to re-run. Expected tail of the first run:

```
applied 014 014_account_locale.sql
```

> `pnpm db:migrate` loads `.env.local` if it exists, **and** a `DATABASE_URL`
> already exported in your shell wins over the file. That is how you migrate a
> managed database without editing `.env.local`.

#### Statement timeout (optional)

Every connection the app opens runs with a PostgreSQL `statement_timeout` —
**10 seconds** by default — so one stuck statement cannot hold a pooled
connection (there are 10, `max` in [src/lib/db.ts](src/lib/db.ts)) and pin a
request or a worker tick indefinitely. It is enforced by PostgreSQL, not by the
client, which is what makes it cover the case the client cannot see: a statement
parked on a lock is otherwise perfectly healthy from the app's side.

You should not need to change it. If your workload has a legitimately slower
statement, raise it:

```ini
STATEMENT_TIMEOUT_MS=30000
```

Accepted range is `100`…`600000` (0.1s … 10min). Anything outside it is ignored in
favour of the default, **including `0`** — PostgreSQL reads `statement_timeout=0`
as "no limit", so honouring it would restore exactly the unbounded behaviour this
setting exists to remove. Migrations are outside this budget
(`scripts/migrate.mjs` builds its own client), so a long index build is
unaffected.

### 3.5 (Optional) Seed demo data

```bash
pnpm db:seed            # two synthetic accounts: demo1@welcome.test / demo2@welcome.test
pnpm exec tsx scripts/seed-demo-event.mts   # a demo event, CSV registrations, one mutual intro
```

Both refuse to run under `APP_ENV=production`. They need `HASH_PEPPER` (email
lookup hashes) and `DATABASE_URL` from `.env.local`. The second seeder finishes
with `SKIPPED: owner<->partner intro not seeded` unless you set
`SEED_OWNER_NAME=<your profile display name>` — that half links the demo partner
to *your* account, and there is no default.

### 3.6 Run it

```bash
pnpm dev        # http://localhost:3000
pnpm worker     # second terminal: the outbox worker (notifications, digests)
```

Open <http://localhost:3000>, sign in with any address you like, then read your
one-time code out of the local transport:

```bash
tail -n 1 .runtime/otp.log     # <iso timestamp> \t <email> \t <code>
```

Expected: `POST /api/auth/otp/request` answers `{"ok":true}` **without** the code
(the response only carries `devCode` when `AUTH_DEV_EXPOSE_OTP=true`, which is
development-only and off by default).

<details>
<summary>Full core-flow transcript from the verification run (minimal env, no external accounts)</summary>

```
[1] POST /api/auth/otp/request → 200 {"ok":true}
    .runtime/otp.log ← 2026-09-17T13:33:46.241Z  selfhost-a-…@example.test  <code>
[2] POST /api/auth/otp/verify  → 200 {"ok":true}   (welcome_session cookie set)
[3] POST /api/me/profile       → 200 public_slug=_dzKII8N6gt-YhH937UZFg
[4] PUT  /api/me/contacts      → 200 {"kind":"whatsapp","public_enabled":true}
[5] PUT  /api/me/contacts      → 200 {"kind":"phone","public_enabled":false}
[6] GET  /api/public/profiles/_dz… (anonymous) → 200; public contact present, private contact absent
[7] POST /api/organizer/events → 201 event selfhost-… (access_mode public)
[8] register user B by code, create profile B
[9] B adds a PRIVATE whatsapp contact (not on B's public card)
[10] both POST /api/events/<slug>/join → 200 membership active
[11] A POST /api/introductions {target_profile_id: B, reveal_fields:["whatsapp"]}
     → 200 state=pending; A sees revealed=[]        ← nothing leaks while pending
[12] B POST /api/introductions/<id>/respond {decision:"accept", reveal_fields:["whatsapp"]}
     → 200 state=mutual
     B sees revealed=[{whatsapp: +34600111222}]      ← A's value
     A sees revealed=[{whatsapp: +34700333444}]      ← B's value
[13] GET /api/public/profiles/<B> → B's revealed value is NOT there
     (the reveal is scoped to the introduction, not to the public projection)
[14] GET /api/internal/worker-tick → 200 {"processed":3,…}
     outbox_jobs → intro_requested_notice:suppressed, intro_mutual_notice:suppressed
[15] GET /api/providers → telegram/email/google-contacts: disabled + not_configured + missing_env
     POST /api/me/enrich → 503 {"code":"enrichment_disabled","retryable":false}
     GET  /api/health    → {"status":"ok","db":"up","worker":"up","pending_jobs":3,
                            "oldest_pending_job_age_seconds":12}
```

The health line is the payload as that run printed it; it predates
`worker_last_tick_age_seconds` (the field list §4.8 documents is the current
shape — the other lines of this transcript are unchanged by that addition).

</details>

---

## 4. Going beyond localhost

### 4.1 Telegram, with your own bot

What it unlocks: Telegram as a notice channel for introductions, reminders and
the weekly digest.

1. Open Telegram, talk to **@BotFather**, send `/newbot`, pick a name and a
   username ending in `bot`. BotFather replies with a token like
   `123456789:AA…`. That is `TELEGRAM_BOT_TOKEN`.
2. Put the username (with the leading `@`) in `TELEGRAM_BOT_USERNAME` — it is
   used to build deep links.
3. Invent a random string for `TELEGRAM_WEBHOOK_SECRET`. The webhook route
   compares it constant-time against the `x-telegram-bot-api-secret-token`
   header.
4. The webhook needs a **public HTTPS URL**, so this step waits until you have a
   domain (see 4.5). Then:

   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -d "url=$APP_BASE_URL/api/webhooks/telegram" \
     -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
   ```

5. Restart the app. `GET /api/providers` must now report `telegram: live`.

The bot is yours; nothing in this repo or in the upstream deployment is involved.

### 4.2 Real email, with your own Resend account

What it unlocks: one-time codes and notifications actually delivered by email.

1. Create a free account at <https://resend.com>, then **API Keys → Create**.
   That value is `RESEND_API_KEY`.
2. **Domains → Add domain**, add the DNS records Resend shows you, and wait for
   verification. Then set

   ```ini
   RESEND_FROM=WELCOME <no-reply@your-domain.example>
   ```

3. Without a verified domain the code falls back to Resend's sandbox sender
   (`onboarding@resend.dev`), which can only deliver to the address that owns the
   Resend account. Fine for a smoke test; not fine for real users — set
   `RESEND_FROM`.

A local alternative with no account at all: leave `RESEND_API_KEY` unset and read
codes from `.runtime/otp.log`.

### 4.3 Google Contacts / Calendar, with your own OAuth client

What it unlocks: importing the connections you already have (matched in memory,
never stored) and pushing one event to your own calendar.

1. In the Google Cloud Console create (or pick) a project.
2. **APIs & Services → Library**: enable the **People API** and the
   **Google Calendar API**.
3. **OAuth consent screen**: pick *External*, fill in the app name and your
   support address, and — while the app is in *Testing* — add your own Google
   address under **Test users**. You do not need Google to review anything for
   personal use.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Under **Authorised redirect URIs** add this value *exactly*:

   ```
   $APP_BASE_URL/api/oauth/google/callback
   ```

   (for local work: `http://localhost:3000/api/oauth/google/callback`).
5. Copy the client id and secret into `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET`.

The client requests exactly two scopes —
`contacts.readonly` and `calendar.events` — which is why the UI says Google
Contacts can *import and match* but cannot write back, and Google Calendar can
*export* but cannot read your calendar. Changing either claim means adding a
scope, i.e. a consent-screen change, not a code change. More detail:
[docs-internal/product/GOOGLE_OAUTH_SETUP.md](docs-internal/product/GOOGLE_OAUTH_SETUP.md).

### 4.4 AI enrichment, with your own Vertex AI credentials

What it unlocks: the "enrich my profile from links" draft. Entirely optional —
without it the route answers `503 enrichment_disabled`.

1. In your GCP project, enable the **Vertex AI API**.
2. Credentials, either way:
   * **Access token** (simplest locally):
     `gcloud auth application-default print-access-token` → `GCP_ACCESS_TOKEN`.
     The token expires; re-run the command when it does. The code only reads the
     variable — it never shells out to `gcloud`.
   * **Service account**: create a key, then paste the JSON into `GCP_SA_JSON`
     (or its base64 into `GCP_SA_JSON_B64`). The key signs a self-signed JWT
     locally, so no token endpoint is called. Treat it as a password.
3. Set `GCP_PROJECT_ID`, and optionally `GCP_LOCATION` (default `global`) and
   `GCP_MODEL` (default `gemini-2.5-flash`).
4. Set `ENRICHMENT_PROVIDER=vertex`.

Note the model id: not every Gemini id is available in every project. If a call
404s, that is the first thing to change.

### 4.5 Your own domain

Any host works (Vercel, Fly.io, a VPS behind nginx, Docker on a home server).
The app itself only needs two things: HTTPS in front, and `APP_BASE_URL` set to
that public origin.

```ini
APP_BASE_URL=https://your-domain.example
CANONICAL_ORIGIN=https://your-domain.example
LEGACY_REDIRECTS=off
```

**About `LEGACY_REDIRECTS`.** The repository ships redirect rules that send two
old `*.vercel.app` hosts to the *upstream author's* domain. Those hosts and that
domain belong to the original deployment, not to you — `CANONICAL_ORIGIN`
defaults to your own `APP_BASE_URL`, and `LEGACY_REDIRECTS=off` drops the rules
entirely. Set it to `off` unless you genuinely inherited those hosts. (If you
did: `LEGACY_REDIRECT_HOSTS=old-host.example,other.example`.)

Then, for whichever optional features you enabled, update the places that carry
your URL:

* Google OAuth: add the new `…/api/oauth/google/callback` redirect URI.
* Telegram: re-run `setWebhook` with the new `APP_BASE_URL`.
* Running on Vercel: `vercel.json` pins the function region to `fra1` (EU) and
  schedules `/api/internal/worker-tick` **daily** (`17 3 * * *`) — that is the
  fastest a free-plan cron may run, and it is normal, not a misconfiguration. It
  is also not your delivery path: the Telegram webhook drains the outbox inline
  after answering, so replies leave seconds after a message arrives; the cron is
  the backstop that keeps a quiet deployment draining and keeps the worker
  heartbeat alive. Do not delete it to quiet an alarm — set
  `WORKER_FRESHNESS_SECONDS` to your own cadence (below) instead. Set
  `WORKER_TICK_SECRET` **and** `CRON_SECRET` (same value) so the cron invocation
  authenticates. On a long-running host, ignore the cron and run `pnpm worker`
  instead, and set `WORKER_FRESHNESS_SECONDS=120` (the worker loops every 2s) so
  `/api/health` reports a stopped worker within minutes rather than a day. The
  project's Node.js setting on Vercel must satisfy the `engines` floor from §2 —
  this project builds on 24.x there, while every gate runs on 22.x.
* HTTPS headers where you terminate TLS. `next.config.ts` sends
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a CSP, a
  `Referrer-Policy` and a `Permissions-Policy` itself. It deliberately does
  **not** send `Strict-Transport-Security`: on Vercel the platform already adds
  one to every HTTPS response (`max-age=63072000`, plus
  `includeSubDomains; preload` on `*.vercel.app`), and a second copy with
  different parameters would leave the enforced value up to the browser. So if
  you front the app with nginx, Caddy or your own load balancer, set it there:

  ```nginx
  add_header Strict-Transport-Security "max-age=63072000" always;
  ```

  Add `includeSubDomains` only once every subdomain of your domain is HTTPS (and
  `preload` only if you really intend to submit to the preload list — it is hard
  to undo).

Also set `OPERATOR_CONTACT_EMAIL` to *your* address — see §5.

### 4.6 Free-tier friendliness

Everything below has a free tier that a personal instance fits into. Limits move,
so check the current numbers before relying on them; this list is about *shape*,
not a promise of price.

| Piece | Free option | Notes |
|---|---|---|
| App host | Vercel Hobby, Fly.io, a VPS, or your own machine | The app is a standard Next.js server. |
| Database | Neon / Supabase free tier, or local PostgreSQL | Requires PostgreSQL 16+; no extensions. Watch the storage cap. |
| Email | Resend free tier | Watch the daily send cap; set `RESEND_FROM` to a verified domain. |
| Telegram | Free (Bot API) | No cost at any realistic volume. |
| Google OAuth | Free | Personal use does not need app verification. |
| Vertex AI | Free credits / pay-per-use | Only if you enable enrichment. The route is off by default. |
| Domain | — | The one thing that costs money, and it is optional: `localhost` is a valid `APP_BASE_URL`. |

The app is deliberately boring about infrastructure: one Node process, one
PostgreSQL database, no queue service, no cache service, no object storage.

### 4.7 Docker: the whole stack in one command

An alternative to §3 for a machine that has Docker and nothing else — no Node, no
pnpm, nothing beyond the repository checkout. It brings up the app, a PostgreSQL
16 server and a one-shot migration job:

```bash
cp .env.example .env       # then edit it — see below
docker compose up -d --build
```

What you get:

| Service | What it is | Notes |
|---|---|---|
| `db` | `postgres:16-alpine` | Data in the named volume `welcome-db-data`, so `docker compose down` is not data loss. No host port is published — the app reaches it as `db:5432` over the compose network, and publishing 5432 would collide with a PostgreSQL already on your machine. |
| `migrate` | The same image, `node scripts/migrate.mjs` | Runs to completion **before** the app starts (`service_completed_successfully`), so "did the schema apply?" is an exit code rather than a log line. |
| `app` | `next start`, non-root (uid 1001) | Health-checked on `/api/health`; only `200` counts as healthy, and the endpoint answers `503` whenever the database is down or the migrations are missing. Measured: stopping the database turns the container `unhealthy` after ~40s (`interval` × `retries`), and starting it again turns it `healthy` within ~20s. |

`.env` is yours and is gitignored. It needs the five variables from §3.3
(`APP_ENV`, `APP_BASE_URL`, `DATABASE_URL`, `ENCRYPTION_KEY`, `HASH_PEPPER`) plus
three that create the container database: `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`POSTGRES_DB`. The compose file overrides `DATABASE_URL` on purpose and points
the app at `db` — a value copied from `.env.example` says `localhost`, which
inside a container is the container itself. Optional: `APP_PORT` (default 3000)
to move the published port.

Useful commands:

```bash
docker compose logs -f app                            # what the app is saying
docker compose exec app id                            # → uid=1001(nextjs) gid=1001(nodejs)
docker compose exec db psql -U welcome -d welcome     # open the database
docker compose down                                   # stop, keep the data volume
docker compose down -v                                # stop and delete the data
```

**`APP_ENV` defaults to `production`** inside this stack: the safe default for
something you may expose. It also means sign-in needs an email provider — with no
`RESEND_API_KEY`, `POST /api/auth/otp/request` answers `503
email_channel_disabled` (deliberate, §8). For a throwaway local trial put
`APP_ENV=development` and `AUTH_DEV_EXPOSE_OTP=true` in `.env` and read the codes
out of the container log; do not do that on a host anyone else can reach.

**What this path does NOT do.** It is a container runner, not a platform:

* no TLS termination and no reverse proxy — put one in front of it (§4.5), and set
  HSTS there, because the app deliberately does not set it itself;
* no monitoring integration beyond the health endpoint itself — the optional
  build/deployment identity that endpoint can publish (`HEALTH_EXPOSE_VERSION`,
  off by default) is documented in `.env.example`;
* **no backups.** The named volume is a volume, not a backup.
  `scripts/backup-rehearsal.mjs` (deployment-specific, §7) rehearses a restore
  against a Neon-style provider and is not wired into this stack;
* **no outbox worker process.** The stack runs the web app only — §4.8 explains
  what that means and how to drain the queue.

### 4.8 The outbox worker: running it, stopping it, and what a stop costs

Notifications (introduction notices, campaign messages, reminders, digests) are
not sent inside the request that triggers them. The request writes a row into
`outbox_jobs` in the same transaction as the business change, and a worker
delivers it afterwards. That is what keeps "the request succeeded" and "the
message was sent" two separate, separately observable facts. Two ways to drain the
queue:

| Path | When | How |
|---|---|---|
| Long-running worker | Any host that keeps a process alive (VPS, Fly.io, Docker) | `pnpm worker` |
| One-tick endpoint | Serverless — nothing keeps a process alive | `GET`/`POST /api/internal/worker-tick` with `WORKER_TICK_SECRET` (Vercel Cron sends it as `Authorization: Bearer $CRON_SECRET`) |

The Docker stack in §4.7 deliberately has **no worker service**: the runtime image
carries production dependencies only, while the worker entry point is TypeScript
run through `tsx` (a devDependency). With that stack, either run `pnpm worker` on
the host against the same `DATABASE_URL`, or schedule the one-tick endpoint with
`WORKER_TICK_SECRET` set. With neither, jobs stay `pending` — visible as
`pending_jobs` / `oldest_pending_job_age_seconds` in `/api/health` — and nothing
is sent. Nothing is lost, and nothing pretends otherwise.

**What `/api/health` says about the worker, and what it does not.** Three fields,
three different facts, deliberately not collapsed into one:

| Field | Meaning |
|---|---|
| `worker` | The verdict: `up` when the last heartbeat is within the freshness window, `down` otherwise. A deployment with **no** worker at all (the Docker stack, or a serverless one with no cron and no pinger) honestly reads `down` — that is not a fault report, it is the absence of a worker. |
| `worker_last_tick_age_seconds` | The measurement behind it: age of the last real tick in seconds, `null` when no tick was ever recorded. Threshold THIS if you need to alert within minutes. |
| `WORKER_FRESHNESS_SECONDS` | The window the verdict uses. Default `93600` (26h = one daily cron period + slack), because the window has to exceed the deployment's tick cadence or a healthy worker reads `down` permanently. Set it to your cadence: `pnpm worker` (2s loop) → `120`, per-minute cron → `180`, the optional 5-minute pinger → `900`. |

Two consequences worth knowing before you wire up a monitor:

* the heartbeat is written by tick sources only. The DB write probe in the health
  check itself cannot refresh it (that was a real defect: the probe used to forge
  the signal it measured, so a monitor pinging `/api/health` kept a dead worker
  looking alive), which is why `worker: down` can be true while `status: ok` and
  `db: up` — the deployment serves fine and the queue is not moving;
* the container healthcheck in §4.7 judges only HTTP 200, which depends on the
  database and the migrations, never on `worker`. A workerless stack staying
  `healthy` is therefore correct behaviour, not a blind spot.

**Shutdown, precisely.** `SIGTERM`/`SIGINT` set a flag that is read *between*
jobs, so:

* a job **already in flight completes** — it is finalised, its lease is released,
  and the delivery is not cut off half-way. Measured by running the real worker
  against a real database with a transport that takes 3 seconds: the signal
  arrived 1.2s into the send, the send finished, the row ended `sent` with
  `lease_until = NULL`, nothing was left `leased`, and the process exited `0`
  after printing `worker_drained`;
* jobs **claimed by the same tick but not yet attempted are released**, not sent
  and not counted as attempts (`status = 'pending'`, `lease_until = NULL`,
  `attempt` unchanged, logged as `worker_released_unattempted`). Without this the
  drain lasted `batch × per-call timeout` — up to 10 × 10s — which any supervisor
  with a shorter grace period (Docker's default is 10 seconds) would cut short
  with a `SIGKILL`;
* a `SIGKILL` (or a host power loss) that skips the handler leaves the lease
  behind, and it is **not** lost: `lease_until` expires after 60 seconds, the next
  tick re-queues the job with `attempt + 1` and a backoff, and it is delivered.
  The honest consequence of that recovery is **at-least-once delivery**: if the
  message had in fact reached the provider before the kill, it is sent a second
  time. Neither provider is sent a dedupe key, so a duplicate is possible after a
  crash — possible, not prevented, and worth knowing if you run reminders.

Both halves are asserted in `tests/integration/worker-shutdown.test.ts` (in-flight
completion plus released neighbours; expired-lease recovery with its backoff and
incremented attempt). Under Docker, give the worker container a
`stop_grace_period` longer than your transports' timeout (10s) so the in-flight
call finishes rather than being killed.

---

## 5. Operator contact

The landing page's pilot call-to-action and the legal pages publish a contact
address. That address is **yours**, from `OPERATOR_CONTACT_EMAIL`:

* **Set** — the pilot CTAs mail you, and the legal pages name you as the
  operator/data-protection contact.
* **Unset** (the default) — no address is published and the pilot CTAs are not
  rendered at all. The legal pages state plainly that no contact address is
  configured rather than printing a mailbox that is not yours.

There is no fallback to the upstream author's inbox anywhere in the code; a unit
test (`tests/unit/operator-contact.test.ts`) and an end-to-end check keep it that
way.

---

## 6. Secrets discipline in this repository

* `.env.local` and every other `.env*` file are gitignored; only `.env.example`
  and `.env.deploy.example` are tracked, and neither contains a value that would
  pass a secret scan.
* `pnpm scan:secrets` is a release gate and a CI step. It scans every tracked
  file for credential-shaped strings and **fails the build** on a hit.
* A test fixture sometimes *has* to look like a credential (a parser test needs a
  Google-shaped access token). For those, the scanner accepts a per-line,
  documented exemption:

  ```ts
  const ACCESS_TOKEN = 'ya29.synthetic'; // secret-scan:allow invented parser fixture, never sent anywhere
  ```

  Rules that keep this from becoming a back door: the marker must be in a comment
  on the same line, the reason is mandatory (≥ 12 characters), **every** exemption
  is printed on **every** run, a marker whose reason is missing or too short does
  not exempt anything, and a marker that matches nothing is reported as stale.
  `tests/unit/scan-secrets-exemptions.test.ts` proves the unmarked case still
  fails, end to end, against a throwaway git repo.
* If you fork this and later find a credential you committed, treat it as leaked:
  rotate it first, then decide about history. Rewriting history does not un-leak
  it.

---

## 7. What this repository is NOT

Read this before you build on it.

* **It is not a hosted service.** There is no SaaS to sign up for, no managed
  instance to point at, and no account to create. You run it; you are the
  operator.
* **There is no data export from the author.** No profiles, contacts, events or
  analytics are transferred, imported or shared with you. Your instance starts
  empty. The live demo at `welcome.colmogravity.net` belongs to the author
  alone — it is a demonstration of the same code, not a backend for your clone,
  and nothing in this repository calls it.
* **No support and no warranty.** MIT licence, provided as is (see
  [LICENSE](LICENSE) and [SECURITY.md](SECURITY.md)). Issues are welcome; an
  SLA does not exist.
* **It is a P0 build.** Early-stage, unversioned-beyond-`0.1.0`, and honest about
  it: `RELEASE_REPORT.md` and `evidence/` record what is verified and what is
  not, including the parts that are deliberately unfinished. There is no claim of
  real users, customers or traction anywhere in this repository.
* **The legal pages are drafts.** `src/app/legal/*` describes what the code
  actually does, but the text has not been reviewed by a lawyer and is not legal
  advice. If you run this for real people, you are the data controller and you
  own that review.
* **Some operational helpers are deployment-specific.** `scripts/usage-matrix.mts`
  (live acceptance matrix), `scripts/backup-rehearsal.mjs` and
  `scripts/phase3-evidence.mts` were written against the author's own deployment
  and database provider. They read their target from the environment
  (`MATRIX_OWNER_EMAIL`, `NEON_API_KEY`, …) and are not part of the self-hosting
  path — you do not need them to run the app.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `HASH_PEPPER is not configured` | Set `HASH_PEPPER` (≥ 8 chars) in `.env.local`. |
| `ENCRYPTION_KEY is not configured` | Generate one: `openssl rand -base64 32`. It must decode to exactly 32 bytes. |
| OTP request answers `503 email_channel_disabled` | `APP_ENV=production` with no `RESEND_API_KEY` — deliberate, fail-closed. Set a key or run in development. |
| `POST /api/me/enrich` → `503 enrichment_disabled` | `ENRICHMENT_PROVIDER` unset — the feature is off, by design. |
| `GET /api/providers` shows `disabled / not_configured` | Correct: that provider's variables are missing, and the response names them. |
| `db:seed` / `db:reset` refuse to run | `APP_ENV=production`. They are destructive; use a non-production environment. |
| No login codes anywhere | They are in `.runtime/otp.log` (development, no Resend key). The file is created on the first request. |
| Migration ran against the wrong database | A `DATABASE_URL` exported in your shell overrides `.env.local`. Check it before running. |
| Worker does nothing | Expected with no channel configured: jobs end as `suppressed:no_channel`. Run `pnpm worker` or hit `/api/internal/worker-tick`. |
| `/api/health` shows `"worker":"down"` | Three real causes, and the payload tells them apart: (1) **no worker is running at all** — the Docker stack (§4.7) ships none, so `down` is the honest answer, and `pending_jobs` will be climbing; (2) **your cadence is slower than the window** — check `worker_last_tick_age_seconds` against `WORKER_FRESHNESS_SECONDS` (default 26h, sized for the daily free-plan cron; the 2s `pnpm worker` loop wants `120`); (3) the worker really is stopped — a healthy cadence would have beaten inside the window. Do NOT respond by removing the cron: see §4.5. |

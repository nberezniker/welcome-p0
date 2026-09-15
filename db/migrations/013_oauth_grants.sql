-- WELCOME P0 migration 013 — OAuth grants for Phase 2 of
-- docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md (§A3 Google rows, §C).
-- Additive: 001-012 tables/columns/CHECKs are untouched; two new tables only.
--
-- Phase 2 turns the two Google rows of the provider registry from `planned` into
-- `live` (env-gated). That needs exactly two pieces of server-side state, and
-- nothing else:
--
--   a) oauth_grants — ONE row per (account, provider): the user's own consent,
--      stored so the server can talk to Google on their behalf later.
--
--      TOKENS ARE ENCRYPTED AT REST through the same AES-256-GCM module that
--      already encrypts contact values (src/lib/crypto.ts, ENCRYPTION_KEY).
--      Neither column is ever read by a client: the routes project a grant as a
--      STATUS WORD ('connected' / 'expired' / 'revoked'), never as a value. The
--      plaintext access/refresh token exists only inside the request that calls
--      Google and is never logged (design §C «OAuth-токены — только на сервере,
--      шифруются; никаких токенов в браузере и логах»).
--
--      One row per provider rather than one per account: the two consent
--      requests ask for DIFFERENT scopes (contacts.readonly vs
--      calendar.events), and the UNIQUE below is what makes "disconnect Google
--      Contacts" unable to silently take the calendar away with it.
--
--      Revocation has two shapes on purpose:
--        - the user presses disconnect → the row is HARD DELETED (the honest
--          "we no longer hold anything" answer) and the token is revoked at
--          Google best-effort;
--        - Google answers `invalid_grant` to a refresh → the CONSENT is gone
--          but the row is kept, stamped with revoked_at + revoked_reason, so
--          the UI can say "revoked — reconnect" instead of quietly showing
--          "not connected" and pretending nothing ever happened.
--
--      refresh_failed_at records "we tried to renew and could not". Together
--      with expires_at and the presence of a refresh token it is what lets
--      src/domain/google-oauth.ts derive the honest state word without storing
--      a status column that could drift from the facts.
--
--   b) oauth_flow_states — the in-flight half of an authorization code + PKCE
--      flow, keyed by the `jti` inside the signed `state` we hand to Google.
--
--      It stores the PKCE code_verifier ENCRYPTED, server-side. The client
--      carries only a SIGNED state string (HMAC over the payload, see
--      src/lib/oauth-state.ts) — never the verifier, and never anything that
--      would let a tampered state be accepted.
--
--      SINGLE USE is the primary key plus a conditional UPDATE:
--        UPDATE oauth_flow_states SET consumed_at = now()
--        WHERE jti = $1 AND consumed_at IS NULL AND expires_at > now()
--      The first callback wins; a replayed state finds consumed_at set and is
--      rejected. The PK makes the check atomic even for two callbacks racing in
--      different serverless instances, which a signature alone cannot do.
--
--      ROWS ARE SHORT-LIVED: expires_at is 10 minutes from `start` and expired
--      rows are purged by the existing retention pass (src/infra/cleanup.ts) —
--      a state row never becomes a lasting record of a connection attempt.
--
-- PRIVACY (design §C, non-negotiable): this migration introduces NO table for
-- contacts, address books, meetings or third parties. A Google contact list is
-- read into memory, matched by peppered HMAC and forgotten — exactly like the
-- .vcf/.csv import — so there is nowhere for it to land even by accident. The
-- only durable facts added here are the user's OWN token and the user's OWN
-- in-flight consent attempt.
--
-- Account deletion already erases both: ON DELETE CASCADE from accounts(id).

-- ---------------------------------------------------------------------------
-- a) oauth_grants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Closed set: the two Phase 2 providers. A third (microsoft-people, github)
  -- needs its own migration line, not a silent string.
  provider text NOT NULL CHECK (provider IN ('google-contacts','google-calendar')),
  -- AES-256-GCM payloads: "v1.<iv>.<ciphertext>.<tag>" (src/lib/crypto.ts).
  -- NOT NULL for the access token: a grant row exists only to be usable.
  access_token_encrypted text NOT NULL,
  -- Google returns a refresh token on the first consent (prompt=consent,
  -- access_type=offline) and may omit it on a later one. Nullable is therefore
  -- a real state, not an error: it is what makes an expiry permanent.
  refresh_token_encrypted text,
  -- Scopes Google actually granted, as returned by the token endpoint. Stored
  -- so a later scope change can be detected instead of assumed.
  scopes text[] NOT NULL DEFAULT '{}',
  token_type text,
  expires_at timestamptz,
  -- 'we tried to renew and could not' — cleared on every successful refresh.
  refresh_failed_at timestamptz,
  -- Consent withdrawn: at Google (invalid_grant on refresh) or detected as such.
  -- The row is deliberately kept so the UI can report it honestly.
  revoked_at timestamptz,
  -- Machine-readable cause, e.g. 'invalid_grant' / 'google_revoked'. Never a
  -- sentence: the UI localizes it, same rule as the provider registry.
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider)
);

-- The connections page asks one question: "which grants does THIS account have".
CREATE INDEX IF NOT EXISTS oauth_grants_account_idx ON oauth_grants(account_id);

-- ---------------------------------------------------------------------------
-- b) oauth_flow_states
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS oauth_flow_states (
  -- Random 128-bit id, base64url — generated server-side, carried inside the
  -- signed state, and the primary key that makes a replay impossible.
  jti text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google-contacts','google-calendar')),
  -- PKCE code_verifier, encrypted like every other secret in this schema.
  code_verifier_encrypted text NOT NULL,
  -- Where the callback sends the user back to. A LOCAL path only (validated by
  -- safeNextPath before it is stored), so a tampered state cannot turn the
  -- callback into an open redirect.
  redirect_path text NOT NULL DEFAULT '/me/connections',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Set by the single-use CAS; non-null means this flow is spent.
  consumed_at timestamptz
);

-- The retention pass and the opportunistic purge on `start` both scan by age.
CREATE INDEX IF NOT EXISTS oauth_flow_states_expiry_idx ON oauth_flow_states(expires_at);

-- WELCOME P0 migration 003 — registration claim challenges.
-- The claiming account is only known at POST /api/registration-claims time:
-- the invite token must never be a bearer credential for an account, so
-- registration_claim challenges are created WITHOUT a bound account and
-- consume only against a session whose email matches the registration.

ALTER TABLE link_challenges ALTER COLUMN account_id DROP NOT NULL;

ALTER TABLE link_challenges ADD CONSTRAINT link_challenges_claim_shape_check CHECK (
  (purpose = 'registration_claim' AND registration_id IS NOT NULL AND account_id IS NULL)
  OR (purpose <> 'registration_claim' AND registration_id IS NULL)
);

# Data-model implementation notes
The canonical concepts are in `docs/04_ARCHITECTURE.md`; `implementation/schema-contract.sql` is a starter DDL, not a complete Supabase migration. RLS policies depend on the chosen Auth claim shape and must be implemented/tested rather than copied blindly.

## Critical invariants
- one account → one durable personal profile;
- profile public slug is random/opaque, not email/name/sequence;
- event membership links profile to many events;
- organizer roles are independent from participant profile;
- registration import is separate from authenticated account;
- one introduction pair is canonical and idempotent in a context;
- each participant gives independent intro-field consent;
- private notes have one owner and never appear in organizer projection;
- channel binding does not make phone/Telegram username public;
- campaign audience is re-evaluated at send time against consent/block/status;
- webhook inbox/outbox have unique dedupe keys.

## Sensitive values
Encrypt private contact values at rest at application/KMS layer or provider-supported encryption; hashes used for lookup must be keyed or otherwise designed to resist simple enumeration. Never expose service role/database master key to browser code.

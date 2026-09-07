# ADR 0001 — Registration-claim link TTL 7d, not the spec's 10min

Status: accepted (Phase 2, recorded Phase 5). Context: `spec/docs/03` drafts a
10-minute link TTL; claim links reach people from an imported CSV who may open
the message days after the event invitation wave.

Decision: `registration_claim` challenges live 7 days (`challengeTtlMinutes`),
one-time use, consumed atomically (CAS), bound to the registration's email
proof (AC-08). OTP codes keep the 10-minute TTL — the 10min figure stays true
for authentication, not for claim horizons.

Consequences: a leaked claim link is valid for up to 7 days BUT only proves
useful to the invited mailbox owner (email proof is enforced) and is single-use
(AC-09). Re-invite rotates the token; old links die with their registration's
claim state. Deviation from the draft spec is intentional and recorded here.

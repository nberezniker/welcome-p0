# ADR 0003 — Personal introduction context_key = canonical min profile uuid

Status: accepted. Context: introductions are UNIQUE(context_key, profile_a,
profile_b). Event intros have a natural key (`event:<eventId>`); two strangers
without a shared event have none.

Decision: personal intros use `personal:<min(profileA, profileB)>` — the
lexicographically smaller profile uuid of the pair (canonicalPair). The pair
ordering itself is canonical, so (A,B) and (B,A) map to one row; the key
guarantees idempotency: a repeated personal request returns the existing intro
instead of duplicating it.

Consequences: one personal intro per pair under that key — a NEW personal
request between the same two people after a decline would collide with the old
row. If product later needs "re-ask after decline", the key must gain a
generation suffix; recorded here as the known limitation, not silently changed.

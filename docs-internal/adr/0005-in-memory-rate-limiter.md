# ADR 0005 — In-memory per-IP token buckets (single-process limitation)

Status: accepted (Phase 5). Context: generic rate limiting for sensitive
routes (OTP request/verify, registration-claims, reports, blocks) was required
without adding an infra dependency (no Redis in P0).

Decision: token buckets live in a per-process Map (`src/lib/ratelimit.ts`),
keyed route+client-IP, refilled continuously (capacity/windowMs), memory-bound
(stale pruning past 50k buckets), X-RateLimit-* headers on governed routes and
429 `retryable:true` on exhaustion. Unit-tested with an injected clock.

Limitations (explicit): state is per process — resets on restart, not shared
across replicas, and IP extraction trusts X-Forwarded-For from the local
proxy. Production plan: move the same interface to a shared store (Redis
INCR+EXPIRE or Postgres counter table) behind `consumeIpToken`; the DB-level
per-subject throttles (OTP per account, joins per profile) already survive
restarts and remain the authoritative business limits.

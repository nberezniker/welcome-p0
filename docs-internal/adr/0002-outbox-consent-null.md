# ADR 0002 — Outbox consent_version NULL + send-time hasGrant re-check

Status: accepted. Context: outbox jobs for campaigns/intro notices are
enqueued before delivery; consents can be revoked between enqueue and send.

Decision: `outbox_jobs.consent_version` stays NULL in P0. We do NOT pin the
consent state at enqueue time. Instead every send path re-evaluates the grant
at delivery time: the campaign send re-validates the frozen snapshot against
the live DB (AC-41) and the worker re-checks the latest consent event, blocks
and channel binding per recipient before actual send (suppress with a reason
code, never deliver).

Consequences: no false sends after a revoke (fail-closed), at the cost of one
extra read per job at send time. A future consent_version pinning can be added
without schema change by populating the column and comparing at send time.

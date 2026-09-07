# Observability, SLOs and operator signals

## Correlation model
Every HTTP request gets `request_id`; every inbox webhook gets `provider_event_id`; every business mutation gets `operation_id`; every outbox delivery has `job_id/attempt_id`. Logs carry IDs, never raw private payloads.

## Product funnel metrics
`profile_created`, `profile_public_viewed`, `event_joined`, `intent_saved`, `recommendations_viewed`, `intro_requested`, `intro_accepted_a`, `intro_mutual`, `next_step_saved`, `next_step_confirmed`, `profile_reused_cross_event`, `profile_direct_scan`, `marketing_opt_in/out`, `delete_completed`.

No event view creates a hidden “lead”. Demo tenants are excluded from business metrics.

## P0 reliability targets (targets, not measured guarantees)
- public card availability: 99.5% monthly pilot target;
- p95 ordinary authenticated API: <800ms on agreed pilot load;
- public card LCP: <2.5s on agreed mobile profile;
- background queue oldest-ready age alert: >5 min;
- Telegram send failure alert: rolling failure >5% after excluding user blocks/suppressed;
- duplicate external event processing: zero by uniqueness constraint;
- RPO target ≤24h, RTO target ≤4h until a stricter business requirement exists.

## Health checks
Homepage 200 is insufficient. Staging/production health should cover app build/version, DB read, safe DB write/rollback probe, migration version, queue/worker heartbeat, provider adapter status (without sending), and recent error budget.

## Alerts
P0 operator channel: email/Telegram to the product owner for DB down, auth down, queue stalled, error spike, webhook verification failures, repeated unknown sends, backup failure and security alert. Alert messages contain IDs + dashboard link, not customer data.

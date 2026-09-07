# Security negative tests
1. Anonymous enumerates sequential/guessed profile IDs: no private data/existence leak.
2. User A changes profile_id in API body to User B: forbidden.
3. Organizer A uses Organizer B event ID on participants/export/campaign: forbidden.
4. Staff calls owner/admin endpoint: forbidden.
5. Public profile response snapshot contains no encrypted/private contact field keys at all.
6. Replayed Telegram/Luma webhook with same event id: one durable effect.
7. Invalid webhook secret/signature: reject before business mutation.
8. Expired/used link challenge: atomically rejected.
9. Two concurrent accepts: one canonical intro state transition, no duplicate send.
10. Withdraw consent while outbox job pending: worker suppresses before send.
11. Block one side after recommendation: no new reveal/message/recommendation.
12. Bio/custom field with HTML/script: rendered escaped; no stored/reflected XSS.
13. CSV cell beginning `=`, `+`, `-`, `@`: safe export/import treatment.
14. Profile/avatar URL to metadata/private IP: server does not fetch P0.
15. 1000 rapid QR/intro requests: rate limiter/bounded degradation, no permission bypass.
16. Error paths do not log token/email/phone/private note.
17. Production config with mock adapter/DEMO seed enabled: build/start gate fails.
18. Review system controlled private-email leak: independent review/gates fail closed.

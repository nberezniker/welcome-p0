# Cost model and spend guardrails

## Principle
The archive contains no guaranteed unit economics. Provider rates change. The implementation must record actual variable costs per event/user and never silently create a paid resource.

## Cost buckets
- web hosting / bandwidth;
- managed Postgres/Auth;
- worker/scheduled compute;
- email OTP/messages if applicable;
- Telegram infrastructure (bot API itself may not be the cost driver; hosting is);
- WhatsApp Business delivered messages/templates by market/category when enabled;
- Luma Plus if API integration is chosen;
- optional LinkedIn app/integration work;
- observability/storage/backups;
- AI tokens only for optional reason/copy generation, not authorization/matching core.

## Budget controls for autonomous build
`autoclaw/preflight-v3.json` has `max_external_spend_eur` and per-provider allow flags. If a new paid service is needed, agent records `BLOCKED_BUDGET` and proposes the free/manual fallback. It may not create a paid plan by clicking through checkout unless explicitly authorized.

## Event unit-cost ledger
For each pilot record: active profiles, public views, messages by channel/category, storage/egress, worker minutes, AI calls/tokens, support time, provider subscription allocation. Report gross contribution only with explicit included/excluded items.

# Reference stack for one-pass implementation

## Recommended
- Node.js current supported LTS at implementation time; do not copy an old lockfile blindly.
- Next.js / React / TypeScript; Tailwind or equivalent minimal design system.
- PostgreSQL. Supabase is a convenient managed option for Auth + Postgres; pick an EU region deliberately.
- SQL migrations checked into repo. Prefer a typed query layer/ORM only if it preserves explicit constraints and RLS visibility.
- Vitest/Jest or Node test runner for unit; Playwright for browser E2E.
- Provider adapters for Telegram/Luma/WhatsApp; no provider-specific code in domain services.

## Domain modules
```text
src/domain/profile
src/domain/event
src/domain/registration
src/domain/matching
src/domain/introduction
src/domain/consent
src/domain/campaign
src/domain/privacy
src/integrations/telegram
src/integrations/luma
src/integrations/whatsapp      # optional
src/integrations/linkedin      # optional
src/infra/db
src/infra/outbox
src/infra/observability
```

## Why not an AI-agent runtime per user
User interactions are authorization-sensitive product operations. They should run through deterministic server routes/services. AutoClaw builds/operates the software; it is not a privileged chat session shared by participants.

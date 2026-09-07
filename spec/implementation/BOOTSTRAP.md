# Bootstrap checklist
1. Create clean target repo/worktree and initial commit.
2. Copy `openspec/`, `contracts/`, selected `docs/`, `tests/` into `spec/` or root; protect them in agent rules.
3. Initialize web project and lock dependencies after checking current stable versions/CVEs.
4. Configure local Postgres or provider emulator; create `.env.example` names only.
5. Add CI: install → format/lint → typecheck → unit → DB integration → e2e smoke → secret/dependency scan.
6. Add migration runner and migration-status endpoint/health check.
7. Add synthetic fixture seeding with `is_demo=true` and a script that refuses to seed production.
8. Implement first vertical slice: public profile + private fields + authorization + QR.
9. Then event import/claim → matching/intro → Telegram → organizer/campaign → privacy/export/delete.
10. Only after all P0 gates, configure staging deployment adapters.

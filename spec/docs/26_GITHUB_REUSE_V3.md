# GitHub reuse v3 — exact map
Research via connected GitHub on 2026-09-07. File SHAs are blob hashes, not commit SHAs. Implementation agent must record current source repo HEAD before adapting anything.

## ColmoCode — reuse the delivery method, not pretend its maker is AutoClaw
Repository: `nberezniker/colmocode`
- `README.md` blob `0dfd9d8f9b00de00aed95cd0f49a569601d88fc4` — OpenSpec/framework-loop/evidence-first workflow.
- `docs/FRAMEWORK-LOOP.md` blob `f96117e360aca63b9d70f60e6b699b0b5621f787` — real gates, READY pending→active, review/handoff.
- `framework-loop/README.md` blob `0add9d1c7594fcfb56bb4f20ec17b8ea7b3e2c85`.
- `framework-loop/install.sh` blob `c3e91609d9ca343c9bd85298157f1251e56d75e6`.
- `framework-loop/assets/loop.sh` blob `4620fd1989e12c92161fa729b501ae0f3d2ba56c` — current maker invokes `agy`; final-review context must be strengthened to exact diff/evidence and contradictory verdicts must fail.

**Reuse:** OpenSpec queue, protected gates, explicit model choice, independent review, evidence, release permission, preview/health/rollback pattern.  
**Adapt:** AutoClaw execution adapter/managed run.  
**Do not claim:** that running current `plan-run` means AutoClaw built the product.

## neko_bot — strong primitive source, domain logic forbidden
Repository: `nberezniker/neko_bot`; package uses Node ≥20, Express/Postgres, Vitest and Playwright.

### Copy/adapt patterns
| Path | Blob SHA | Use in WELCOME | Caveat |
|---|---|---|---|
| `src/channels/adapter.js` | `3cdab4a4ff8f2950dfae64477a914203828093b2` | tiny provider adapter abstraction + mock pattern | remove Instagram/story/comment concepts; return richer delivery states |
| `src/pii/redactor.js` | `363ae39687f526eb8e5468620dcffd5d92db42dc` | PII-redaction test ideas before optional LLM calls | regex is not full DLP; do not rely on it as sole security control |
| `src/pipeline/scheduler.js` | `59b3d91c01fbb0e1432f5196102f09b9ac065bd9` | scheduled-message → outbox pattern | salon timings/marketing logic replaced; timezone and consent recheck required |
| `src/pipeline/*` + tests | see source tree | durable dispatch/worker/E2E testing ideas | reimplement around WELCOME domain + provider idempotency |
| `src/db/migrate.js`, `src/db/repo.js`, migrations/tests | see source tree | migration/repository discipline, SQL tests | schema is salon-specific, never copy tables wholesale |
| `scripts/run-e2e-scenarios.js`, `run-playwright-simulation.js` | see source tree | scenario-harness style | replace real/salon fixtures with synthetic WELCOME fixtures |
| `src/campaigns/engine.js` | `34b8135a9bb7b5be30fad679f0b7307ee83dd399` | rate/cooldown/audience prefilter idea | business logic is salon marketing; WELCOME requires purpose-scoped eligibility at send time |

### Specifically DO NOT reuse consent semantics
`src/consent/service.js` blob `2aeb12437c0ac761922ef21f2ece2b40bc814fbb` includes logic where an explicit language change is treated as consent. WELCOME **must not** inherit this. Build purpose-scoped explicit affirmative controls instead. Keep only the idea that consent is a separate service with tests.

### Do not copy
Altegio/booking/Instagram scraping or sender, salon prompts/persona/KB, campaign copy, real customer state/cookies, existing production env/deployment target.

## linkedrink / linkedrink-os
Current READMEs show LinkedIn expert/content-operation products, not a confirmed event Welcome bot. Useful only for general Next.js/UI patterns after reading concrete files and license/dependency state. No event/auth module is considered pre-verified.

## “old Welcome bot” discovery result
Exact repo/code search for `welcome`, `welcome-bot`, `welcomebot` did not identify a standalone Welcome event bot in the currently accessible default branches. This is not proof that it never existed in another branch/archive. V3 does not waste implementation time searching indefinitely: max 20 minutes/15 reads, then proceed with the verified primitives above.

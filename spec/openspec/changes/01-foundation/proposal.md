# Web/backend foundation

## Scope
Создать Next.js/TypeScript проект, тестовый стек, staging PostgreSQL/Auth, migration mechanism, конфигурацию и feature flags. Демо tenant отдельно от live.

## Acceptance
CI запускает typecheck/lint/unit/build; отсутствие обязательной env даёт BLOCKED, production не использует mock adapters.

Связанные проверки: AC-04 AC-05 AC-06.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

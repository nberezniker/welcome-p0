# RLS и consent engine

## Scope
Проверить roles, tenant isolation, purpose/scope-based consents, privacy screen, block/report, retention и delete/export.

## Acceptance
Прямые API/SQL tests с двумя organizer/user контекстами: ноль чужих private данных; отзыв membership/consent действует немедленно.

Связанные проверки: AC-22 AC-23 AC-24 AC-25 AC-26.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

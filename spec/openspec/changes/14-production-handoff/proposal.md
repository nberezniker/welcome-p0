# Production и handoff

## Scope
Только при owner release authority, credentials и проверенном target продвинуть тот же artifact; health; при сбое exact rollback.

## Acceptance
Нет превентивного production на каждой задаче; финальный report готово/не проверено/disabled; SHA/URLs/evidence, без секретов.

Связанные проверки: AC-58 AC-59 AC-60.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

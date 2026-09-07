# Preview release

## Scope
Выбрать подтверждённый target, реализовать deploy/smoke/health/rollback scripts и policy. Публиковать immutable reviewed artifact на staging.

## Acceptance
Публичный URL доступен с чистого браузера; реальный QR на телефоне; реальный Telegram; staging restore/rollback; seed явно подписан.

Связанные проверки: AC-55 AC-56 AC-57.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

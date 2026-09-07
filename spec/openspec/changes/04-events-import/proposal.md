# События и предрегистрация

## Scope
Event CRUD, organizer roles, собственная регистрация и CSV mapping/preview/commit. Pending registrations не превращаются в публичные аккаунты.

## Acceptance
Повторный import idempotent; конфликт не перезаписывает подтверждённый профиль; CSV limits/injection; private event approval; UTC/IANA timezone.

Связанные проверки: AC-17 AC-18 AC-19 AC-20 AC-21.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

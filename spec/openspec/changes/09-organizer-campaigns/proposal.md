# Организатор и разрешённые рассылки

## Scope
Дашборд, scoped opt-in каталог, campaign preview/test-send/approve/queue, purpose filters и delivery states.

## Acceptance
Marketing checkbox off; send исключает revoked и foreign tenant; edit resets approval; timeout unknown не становится delivered.

Связанные проверки: AC-40 AC-41 AC-42 AC-43.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

# Двусторонние знакомства

## Scope
State machine предложения/ответа/отзыва; атомарный mutual transition; private fields per party; личные notes и next step.

## Acceptance
Две гонки accept создают один transition/outbox; до двух согласий нет private reveal; чужой actor id не принимается; revoked отменяет pending job.

Связанные проверки: AC-31 AC-32 AC-33 AC-34 AC-35.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

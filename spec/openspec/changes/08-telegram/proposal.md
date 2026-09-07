# Live Telegram adapter

## Scope
Webhook secret/inbox dedupe, /start/deep link, команды, link challenge, errors/stop и outbox worker.

## Acceptance
Два реальных тестовых аккаунта, отправка и webhook round trip; repeat update no duplicate; блок бота обработан; chat id не в public response.

Связанные проверки: AC-36 AC-37 AC-38 AC-39.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

# Identity и безопасный claim

## Scope
Реализовать email OTP, Telegram-first identity, purpose-bound challenges и two-sided linking; тест email-forwarding и несовпадения владельца.

## Acceptance
GET claim не потребляет token; токен одноразовый и истекает; нельзя объединить по имени/LinkedIn; корректные 401/403/409/429.

Связанные проверки: AC-07 AC-08 AC-09 AC-10 AC-11.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

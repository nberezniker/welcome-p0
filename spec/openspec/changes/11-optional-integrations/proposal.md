# Управляемые integration gates

## Scope
WhatsApp Business, LinkedIn OIDC и Luma adapter реализовать только при подтверждённых доступах. Personal wa.me/share остаются P0.

## Acceptance
Для каждого adapter live или disabled с evidence reason; WA template/window tests; OIDC issuer/state; Luma dedupe/signature по реальному контракту.

Связанные проверки: AC-48 AC-49 AC-50.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

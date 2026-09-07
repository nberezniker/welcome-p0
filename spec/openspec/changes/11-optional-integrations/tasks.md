# Управляемые integration gates

- [ ] Прочитать контракты и зафиксировать dependencies/allowed paths для этого change.
- [ ] WhatsApp Business, LinkedIn OIDC и Luma adapter реализовать только при подтверждённых доступах. Personal wa.me/share остаются P0.
- [ ] Проверить: Для каждого adapter live или disabled с evidence reason; WA template/window tests; OIDC issuer/state; Luma dedupe/signature по реальному контракту.
- [ ] Независимый review, evidence и commit; закрыть AC-48 AC-49 AC-50 только по результатам.

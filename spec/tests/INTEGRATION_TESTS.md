# Integration fixtures
## Telegram
Use one dedicated staging bot and two synthetic Telegram accounts if possible. Record update id/message id/status with IDs redacted from public artifact. Test link, inbound, outbound, stop/unlink, invalid start token, replay.

## Luma CSV
Use `templates/luma-import-example.csv` plus fixtures for duplicate guest id, duplicate email, changed company, unknown approval status, formula cell, 10MB/row-limit boundary, non-UTF8/invalid CSV.

## Luma API optional
When key exists: list/backfill a synthetic event, receive/register/update webhook as docs permit, repeat same event, simulate 429/5xx. No real attendee data in tests.

## WhatsApp optional
Only with a real test WABA/number: inbound opens service window, free-form reply in window, approved template outside if authorized, webhook status update, opt-out/suppression. Record current rate category/market rather than a hard-coded price.

## LinkedIn optional
OIDC state/nonce/redirect allowlist, successful lite profile, missing email, revoked access, user edits company/title manually. Test that no employment-history fields are inferred from OIDC response.

# Постоянный профиль и QR

## Scope
Профиль вне event, по-полевая видимость, public projection, vCard, share, profile disable/delete. Перенести визуальный язык landing.

## Acceptance
Без аккаунта открываются только опубликованные поля; два разных event сохраняют один profile id; QR не логинит владельцем; vCard escaping и cache purge.

Связанные проверки: AC-12 AC-13 AC-14 AC-15 AC-16.

## Evidence
Command, exit code, artifact path, reviewed SHA/diff hash. Tests/release state are controlled by driver, not maker.

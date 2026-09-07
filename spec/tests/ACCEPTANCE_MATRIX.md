# Acceptance matrix — продукт

Все ниже: **NOT RUN** для production. Локальные preview/core тесты перечислены отдельно в evidence. Проверить каждый AC, не отмечать по наличию документации.

| ID | Область | Проверка | Ожидаемый результат |
|---|---|---|---|
| AC-01 | Adapter | Пустой verdict или одновременно PASS/FAIL | BLOCKED; не accepted |
| AC-02 | Adapter | Review SHA не равен release SHA | Review invalidated |
| AC-03 | Adapter | AutoClaw недоступен, agy установлен | Нет скрытого fallback |
| AC-04 | Foundation | Неполная обязательная env | Не стартует production |
| AC-05 | Foundation | Mock transport в production config | CI fails |
| AC-06 | Foundation | Зависимость содержит critical CVE | Release blocked |
| AC-07 | Identity | GET из email scanner открывает claim | Token остаётся unconsumed |
| AC-08 | Identity | Claim переслан другому email | 403, никакого чужого профиля |
| AC-09 | Identity | Одновременные consume token | Один успех, один already_used |
| AC-10 | Identity | Дублирующее имя/LinkedIn URL | Не объединять accounts |
| AC-11 | Identity | Украден challenge канала | Нет binding без двух подтверждений |
| AC-12 | Profile | Аноним открывает personal QR | Только public projection |
| AC-13 | Profile | Email privacy off | Нет email в HTML/JSON/vCard/cache |
| AC-14 | Profile | Один профиль на двух событиях | Один profile_id, разные memberships |
| AC-15 | Profile | QR открыт на чужом телефоне | Нет owner session |
| AC-16 | Profile | vCard name с CRLF | Корректный escaping, нет injected fields |
| AC-17 | Events | Дважды импортирован тот же provider_guest_id | Одна registration |
| AC-18 | Events | Import меняет verified profile | Нужен выбор владельца |
| AC-19 | Events | CSV содержит формулу/HTML/слишком много строк | Нейтрализовать/отклонить безопасно |
| AC-20 | Events | Private event URL известен постороннему | Не раскрывать directory/online link |
| AC-21 | Events | DST/Europe-Madrid/UTC | Время корректно, физическое присутствие не выводится из join |
| AC-22 | Tenancy | Организатор A читает event B напрямую | 403 или пустая разрешённая проекция |
| AC-23 | Tenancy | Staff запускает marketing campaign | 403 |
| AC-24 | Consent | Вступление в событие без marketing consent | Не подписывать |
| AC-25 | Consent | Отозвано согласие пока job queued | Отправка suppressed |
| AC-26 | Privacy | Удалён account | Профиль закрыт, pending jobs canceled, clear retention report |
| AC-27 | Matching | Стороны только ищут одно и то же | Нет bilateral recommendation |
| AC-28 | Matching | Self/blocked/nonmember | Исключены |
| AC-29 | Matching | Обратный порядок a,b | Равный score |
| AC-30 | Matching | Ноль кандидатов | Нормальное empty state |
| AC-31 | Intro | Согласилась только одна сторона | Нет private reveal |
| AC-32 | Intro | Два concurrent accept | Один mutual transition/outbox |
| AC-33 | Intro | Actor id подменён в body | Сервер использует auth actor |
| AC-34 | Intro | После mutual отозваны поля | Будущие private reads запрещены |
| AC-35 | Notes | Другой участник/организатор читает note | 403 |
| AC-36 | Telegram | Неверный webhook secret | 401/403 до обработки |
| AC-37 | Telegram | Повтор update_id | Одна business operation |
| AC-38 | Telegram | Live Start→profile→match на двух телефонах | Round-trip evidence |
| AC-39 | Telegram | Пользователь блокирует бота или /stop | suppressed, без обхода |
| AC-40 | Campaigns | Edit после approved preview | Approval сброшен |
| AC-41 | Campaigns | Тестовая audience содержит чужой tenant/revoked | Исключить перед send |
| AC-42 | Delivery | Provider timeout после принятия send | unknown; не delivered и не бесконечный resend |
| AC-43 | Delivery | 429 и retry-after | Управляемый backoff/lease |
| AC-44 | UX | 360/390/768/1440 px | Нет horizontal overflow |
| AC-45 | UX | Keyboard/dialog/Escape | Focus управляется, label доступны |
| AC-46 | UX | Неизвестный новый посетитель | Нет ложного auto-profile claim |
| AC-47 | UX | Нет сети на незагруженном телефоне | Не обещать offline web; видимое состояние |
| AC-48 | WhatsApp | Нет approval/credentials | Disabled; personal link не считается API |
| AC-49 | LinkedIn | OIDC не вернул company/job | Не выдумывать профессиональные данные |
| AC-50 | Luma | Webhook replay/unknown status | Dedupe/quarantine по actual contract |
| AC-51 | Security | Bio с prompt injection/XSS | Данные не выполняются, tools не вызываются |
| AC-52 | Security | SSRF URL/CSRF mutation/IDOR | Запрещено/validated |
| AC-53 | Load | 50 concurrent writes и event 200 | Измеренные p95/error rate в report |
| AC-54 | Backup | Staging restore из backup | Проверка целостности и recovery timing |
| AC-55 | Preview | Публичный QR с телефона | Открывает actual public domain |
| AC-56 | Preview | Health homepage200 worker dead | Release fails |
| AC-57 | Preview | Staging rollback rehearsal | Возвращён exact previous artifact |
| AC-58 | Production | Нет owner release permission | Production BLOCKED |
| AC-59 | Production | Health после promotion падает | Rollback + FAIL status |
| AC-60 | Handoff | Только локальный landing прошёл tests | Не PASS_P0_PRODUCTION |
| AC-61 | Contest | Нет официальных правил/дедлайна | BLOCKED_CONTEST_RULES |
| AC-62 | Contest | AutoClaw не был maker | Не ложная attribution |

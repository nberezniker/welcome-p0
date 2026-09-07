# Архитектура, данные, безопасность и API
Статус: обязательный проектный контракт. Предлагаемая схема не является уже установленной БД.

## 1. Состав системы
```text
QR / link / event registration
             ↓
 Next.js web + server API  ←→  Supabase Auth
             ↓
      Domain services
  identity / profile / event / introductions / policy / campaigns
             ↓ (одна транзакция business change + outbox)
 PostgreSQL: keys + constraints + RLS + audit
             ↓
 scheduled outbox worker → Telegram adapter / WhatsApp adapter / email adapter
             ↑
       signed webhooks → durable inbox → deduplicated processing
```
Web hosting и backend регион выбираются явно. EU-регион БД сам по себе не решает все вопросы трансграничной передачи данных через другие сервисы.

Нет общей глобальной «сессии AI» на всех посетителей. Нет доступа participant messages к файловой системе/терминалу/секретам/инструментам AutoClaw. Настройки разработки и пользовательская функциональность физически разделены.

## 2. Таблицы и инварианты
| Таблица | Основные поля и уникальность | Доступ |
|---|---|---|
| accounts | id UUID, auth provider subject, status, created_at | Только владелец + служебные операции |
| auth_identities | account_id, provider, provider_subject, verified_at; UNIQUE(provider, subject) | Сервер; не email/username как незащищённый ключ |
| profiles | id, account_id UNIQUE, slug UNIQUE случайный ≥128-bit, name, headline, offers, needs, bio, revision | Владелец; public projection отдельно |
| contact_fields | profile_id, kind, encrypted_value, public_enabled, verified_at | Владелец; раскрытие через policy function |
| organizers | id, display_name, legal_contact, status | Только уполномоченные роли |
| organizer_members | organizer_id, account_id, role; UNIQUE(org, account) | Owner/admin/staff по разрешениям |
| events | id, organizer_id, slug, mode, starts_at, ends_at, timezone, access_mode, directory_close_at | Открытая проекция отдельно; private join info только членам |
| registrations | id, event_id, external_provider/id, email hash lookup + encrypted email, imported_data, claim_status | В пределах события; не видны анониму по токену |
| event_memberships | id, event_id, profile_id, state, intent, visibility, attendance_source; UNIQUE(event, profile) | Владелец + ограниченная event projection |
| channel_bindings | account_id, provider, external_id, status, last_inbound_at; UNIQUE(provider, external_id) | Сервер; отдельно от публичных контактов |
| link_challenges | hash(token), purpose, initiating_account, candidate_channel, expires_at, consumed_at, proof_flags | Сервер; compare-and-set, одноразовый |
| consent_events | account_id, purpose, scope_type/id, field_set, policy_version, action, created_at | Append-only, auditable; значение не угадывается из start |
| introductions | id, a_profile, b_profile, nullable event_id, context_kind, state, revision | Только стороны; org не видит приватные пары |
| introduction_consents | intro_id, profile_id, fields, action, consent_version | UNIQUE(intro, profile), две независимые стороны |
| connection_notes | owner_id, other_profile_id, intro_id?, text, next_step, next_step_status | Только owner; не организатору/другой стороне |
| blocks / reports | blocker,target / reporter,target,reason,status | Сервер; block symmetric visibility suppression |
| campaigns | id, organizer_id, event_id, purpose, approved_revision, state | Admin; изменение текста сбрасывает approval |
| inbox_events | provider, external_event_id UNIQUE, received_at, status, minimal_payload | Только worker; payload TTL |
| outbox_jobs | id, dedupe_key UNIQUE, kind, subject_id, due_at, status, lease_until, attempt, channel, consent_version | Только worker |
| delivery_attempts | job_id, attempt_id, provider_message_id, state, code | Только worker, redacted logs |
| audit_events | actor, action, target, timestamp, redacted_metadata | Restricted audit; без токенов и содержимого приватных сообщений |

Пара intro хранится канонически: min/max profile UUID, no self-intro; partial unique для активной пары в данном контексте. Для personal context `event_id=NULL` не полагаться на обычную SQL UNIQUE с nullable полем: отдельный context_key или два partial unique indexes. Изменения и consent commit в транзакции с row lock. Повторное нажатие возвращает прежний id, не создаёт новую отправку.

Смысл consent всегда ограничен scope: public card; event directory; introduction fields; service channel; organizer marketing; product marketing. Отзыв organizer marketing не удаляет билет/профиль и не отключает уже запрошенный просмотр контакта.

## 3. Авторизация и RLS
RLS включить по умолчанию на каждой пользовательской таблице. Anonymous получает **только публичную проекцию** через серверный endpoint, не `select * profiles join contacts`. Authenticated не значит «имеет доступ ко всем участникам».

Org role проверяется server-side по `organizer_members`, а не по org_id из формы. Staff не получает право campaigns/export/roles, если не назначено явно. Роли: owner; admin event manager; staff check-in/поддержка с минимальными полями; participant. Межтенантные тесты идут на прямые API и SQL claims, не только в UI.

Служебный ключ БД никогда не попадает в client bundle или NEXT_PUBLIC_. SQL/RPC, читающие private contact values, исполняются только после проверенной policy. Применить фиксированный search_path для SECURITY DEFINER; не принимать actor_id из произвольного body. Наличие service-role запроса не заменяет application authorization.

Публичные поля не являются конфиденциальными после явной публикации. Для event-only private pages: no-store/private cache, noindex, Referrer-Policy no-referrer; публичную карточку можно коротко кэшировать только с purge при отзыве. CDN не смешивает authenticated ответы.

## 4. Identity и токены
Email OTP — ограничение попыток и enumeration-safe ответы; OTP expires по настройке провайдера, target 10 минут. Link challenge ≥128-bit entropy, base64url, purpose-bound, hash в БД, TTL 10 минут, один consume transaction. `GET` не потребляет приглашение: email scanners не должны завершать регистрацию. POST после проверки identity завершает claim.

URL содержит opaque token, не email/phone/PII. Browser challenge страницы не грузят analytics/внешние картинки. Отдельные токены для registration claim, channel binding и invitation; токен профиля никогда не служит для входа.

Идентичность связывается по двум доказательствам, не по совпадению имени. Миграция на другой email и восстановление — отдельные auth flows с аудитом и reauth. Изменение публичного LinkedIn URL не считается верификацией владения LinkedIn аккаунтом.

## 5. API — поведение
Все mutations: auth, schema validation, rate limiting, audit, optional Idempotency-Key; одинаковый ключ с другим payload →409. По объектным ID всегда object-level authorization. Error model: code, message, correlation_id, retryable; не стек/SQL/секреты.

`GET /api/public/profiles/:slug` → только разрешённые поля; не счётчик полного досье.
`GET /api/public/profiles/:slug/vcard` → тот же projection; корректное escaping CR/LF, запятых, обратной косой черты. Не превращать name в многострочную инъекцию.
`POST /api/me/profile` → version check; stale revision →409.
`POST /api/events/:eventId/imports` → mapping/preview/commit; admin only; parser limit 5MB/5k строк; телефоны не обязательны.
`POST /api/registration-claims` → token + verified account, no cross-email claim.
`POST /api/events/:eventId/join` → explicit membership state, event policy.
`GET /api/events/:eventId/recommendations` → разрешённая выборка, top≤3, reason facts.
`POST /api/introductions` → proposal + initiator choice of private fields.
`POST /api/introductions/:id/respond` → accept/decline/revoke; вторую сторону нельзя указать в body.
`POST /api/channels/:provider/challenge` → one-time binding, explicit user confirmation.
`POST /api/webhooks/telegram` / `whatsapp` → signature/secret check before durable inbox insert; duplicate→200 без повторного business action.
`POST /api/organizer/campaigns/:id/send` → approved revision + target snapshot, lawful/policy filter; 202 job id.
`POST /api/consents/revoke`, `POST /api/reports`, `POST /api/me/export`, `DELETE /api/me`.

Сводный machine-readable contract — `contracts/api-contract.json`; исполнитель генерирует из него runtime Zod validation и OpenAPI, затем проверяет contract tests. Сам JSON не является работающим API.

## 6. Матчинг: детерминированное ядро
Controlled tags одинаковы во всех локалях; отображаемые подписи переводятся отдельно. Для a→b:
`d(a,b) = count(a.needs ∩ b.offers) / max(1, count(a.needs))`.
Сначала eligibility: активное членство одного разрешённого события, directory+matching enabled, нет block в обе стороны, не self, есть общий язык (или оба явно разрешили помощь перевода), не существующая активная/закрытая пара в cooldown.

Если любое `d` =0, не называть пару взаимной рекомендацией. Отдельный opt-in режим mentorship/односторонней помощи можно добавить P1; не смешивать его с bilateral score.

`score=round(100*(0.6*min(dAB,dBA)+0.4*(dAB+dBA)/2))`.
Сортировка score desc, затем меньше pending introductions, затем стабильный profile id. Цель top3; similarity названий должности сама по себе не создаёт рекомендацию. Tie-break не по полу/национальности/фото/доходу.

Reason состоит только из фактических общих тегов и profile fields. LLM может переформулировать, но не придумывает опыт, обещания или ответ второй стороны. Матчинг должен пройти тесты symmetry, no-self, no-private-data, no-match-empty, stable-order и withdrawal-before-send. Эталонное ядро в `contracts/matching.mjs` иллюстрирует формулу; production eligibility выполняется сервером с актуальной БД.

## 7. Сообщения и фоновые задачи
Inbox: принять только валидный webhook, сохранить durable minimal event до ACK, уникальность external id. Outbox: в той же транзакции с intro/campaign создать одну job. Worker берёт lease через транзакцию/`FOR UPDATE SKIP LOCKED`; лимитируем batch, refresh lease, retry с jitter/backoff. Не держать SQL transaction открытой во время внешнего HTTP.

Перед фактической отправкой повторно проверить binding, блокировку, membership, consent version и допустимое окно канала. Старый snapshot аудитории не обходит отзыв. Контакты и приватные поля не прикладывать целиком к сообщению: безопаснее ссылка на авторизованный экран.

При transport timeout после send результат может быть **unknown**: нельзя безусловно отправлять повторно и обещать exactly-once. Использовать provider idempotency где поддержан, reconciliation по provider_message_id где доступна; для неизвестного исхода не делать бесконечный resend. Permanent 4xx, blocked user → suppressed/failed. 429 → provider retry-after. Service-window errors → ждать допустимого шаблона/канала, не менять purpose на marketing незаметно.

Dead letter доступен администратору без private payload. Retry only explicitly controlled. Отписка отменяет релевантные ещё не отправленные jobs. Уже доставленное сообщение не объявлять удалённым с телефона.

## 8. Интеграции
Telegram: HTTPS webhook; проверка X-Telegram-Bot-Api-Secret-Token; unique update_id. `/start`, `/profile`, `/qr`, `/events`, `/need`, `/matches`, `/connections`, `/privacy`, `/stop`, `/help`, `/delete`. Deep-link payload ≤64 допустимых символов. Bot не начинает произвольный личный диалог до пользовательской активации. [S14]

LinkedIn: официальный OIDC с nonce/state, PKCE при поддержке выбранного provider flow, проверка issuer/audience/signature и redirect allowlist. Scopes только openid/profile/email; имя/фото/email согласно доступному ответу. Company/job/history не предполагать. URL вводится/подтверждается человеком, без фонового scraping. [S15]

WhatsApp: WABA/номер/токен и подписанный webhook; verify challenge; inbound opens 24h customer-service window, которую обновляет новое сообщение пользователя. Вне окна — разрешённые утверждённые шаблоны/категории, правила opt-in и актуальная тарификация; конкретную стоимость брать из живой rate card для страны получателя. Ссылка wa.me не равна API automation. [S16–S17]

Luma: CSV P0. API требует подтверждённого доступа/тарифа; официальная help page связывает API с Luma Plus. Webhook verification и replay window реализовать по реальной документации; unknown event/status маппить в quarantine, не в approved. CSV и повторный webhook должны давать одну registration запись. [S11–S13]

## 9. Безопасность и приватность до запуска
GDPR: прозрачная цель обработки, минимизация, правовое основание, применимые права пользователя и возможность отозвать согласие. Организаторский marketing и сервисные уведомления не объединяются одним checkbox. Роли controller/processor, DPA, retention и действующие требования электронной рекламы проверяются для фактической страны запуска. Это инженерный проект, не готовое юридическое заключение. [S18]

Threat model: forwarded claim link; QR tampering; IDOR; inter-tenant leakage; duplicate identities; CSRF; XSS в bio и CSV; CSV formula injection при экспорте; SSRF через remote avatar/LinkedIn URL; webhook spoof/replay; bot callback ID spoof; admin takeover; rate-limit bypass; prompt injection; deleted data in caches/logs/backups; массовая рассылка после unsubscribe.

Для P0 не загружать внешние URL сервером вообще. Avatar — заранее подготовленный/безопасно загруженный файл с ограничением формата/размера; URL профиля валидируется, но не fetch. Plaintext bio, escaped React text, запрет HTML. CSV export neutralizes `= + - @` формулы в начале значений. Контактные поля не пишутся в error-monitoring breadcrumbs.

MFA для organizer owner, минимальные production privileges, секреты только secret manager/env, secret scanner перед push. Никаких browser cookies из LinkedIn/WhatsApp Web в Git. AI получает только разрешённые нормализованные поля; не выбирает tools/получателей/права.

## 10. Release и эксплуатация
Раздельные staging/production БД и bot IDs. Seed only demo tenant, поле is_demo=true; demo не участвует в продуктовой аналитике. CI проверяет отсутствие enabled mock transport в production build.

Preview release содержит commit SHA, build digest, migration version, frontend URL, worker version. Миграции expand/contract, резервная копия перед изменениями, старый runtime совместим с новой схемой. Rollback кода не обещает откат разрушительной миграции.

Smoke: landing; public card; auth; event join; one mutual intro; real Telegram message; revoke; cross-tenant forbidden. Production promote только того же immutable artifact после review. Health check включает DB read/write и worker heartbeat, не только 200 на homepage.

Проверить восстановление из backup на staging. Цели пилота: RPO≤24h, RTO≤4h — согласованные цели, не измеренная гарантия. При инциденте отключить отправки feature flag, сохранить аудит, не пересобирать прошлый неизвестный image как rollback.

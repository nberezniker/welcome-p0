# USAGE MATRIX — живой прогон всех режимов

- **BASE:** https://welcome.colmogravity.net (`--live`=true)
- **Прогон:** 2026-09-15T17:50:01.448Z → 2026-09-15T17:53:44.670Z
- **Итог:** 125 PASS / 0 FAIL / 1 SKIP / 0 BLOCKED (всего 126)
- **Машинный отчёт:** [usage-matrix.json](usage-matrix.json)

## Инкремент этого прогона

| ID | Что | Коммит | Изменения | Тесты |
|---|---|---|---|---|
| CI1 | Импорт адресной книги: «кто из моих контактов уже здесь» — без Google OAuth | `ea74261 + edcfcfa + 08cf21a + 14ac172` | src/domain/contact-import.ts — чистый парсер: vCard (FN/N/EMAIL, несколько карточек, складывание строк, CRLF/LF/CR, группы item1.EMAIL; PHOTO/LOGO/KEY/SOUND и base64/quoted-printable игнорируются, а не додумываются; карточка без адреса = skipped) и CSV (существующий RFC4180-парсер + авто-детект колонок EN/RU с приоритетом exact → full → given и исключением family/last/middle, позиционный фолбэк для файлов без заголовка; незакрытая кавычка — отказ, а не половина файла); лимиты 5 МБ / 5000 контактов, превышение честно помечается truncated. POST /api/me/contacts/import — 401, 400 invalid_body/no_contacts/csv_parse_error, 413 на оба лимита, 429; бюджет 5/час на аккаунт в памяти (новый consumeSubjectToken в src/lib/ratelimit.ts, рядом с пер-IP бакетами; таблица-счётчик отклонена, потому что импорт обещает не оставить ни строки); сопоставление — emailLookupHash(email, HASH_PEPPER) по accounts.email_lookup_hash (только active, кроме себя); в ответе display_name/slug/headline ≤50 и НИ ОДНОГО email; единственная запись в БД — audit_events с двумя числами. Карточка «Импорт контактов» на /me/connections (файл .vcf/.csv или вставка, результат «N из ваших контактов уже здесь» со ссылками /p/<slug>, приписка о непосохранении, локализованные ошибки) и capability match у vcard/csv в реестре + docs-internal/product/GOOGLE_OAUTH_SETUP.md. | unit: contact-import (+20 — карточки/складка/кодировки/дедуп/лимиты/детект формата/дегенеративные входы, «только email+name»), rate-limit-bucket (+1 — пер-субъектный бакет изолирован от per-IP и других маршрутов); integration: contact-import (+8 — матч по известному адресу и ответ без единого @, CSV-путь, self/disabled исключены, СНИМОК всех таблиц «ничего не сохранено» (+1 только audit_events) и отсутствие хеша импортированного адреса, 401 без следа, 400 на мусор, 413 на оба лимита, 429 на шестом с Retry-After и 200 у другого аккаунта); e2e: contact-import (+2 — реальный сосед, созданный через OTP, найден загрузкой настоящего .vcf; отказ на файле без адресов); живые чеки S9 (панель на странице), S11–S13. |

## Часть 1 — автоматические гейты (локально)

| Гейт | Команда | Exit | Результат |
|---|---|---|---|
| typecheck | `pnpm typecheck` | **0** | 0 ошибок tsc --noEmit |
| lint | `pnpm lint` | **0** | eslint clean (0 errors, 0 warnings) |
| test:unit | `pnpm test:unit` | **0** | 459 pass / 0 fail (node --test + tsx, 459 tests) |
| test:integration | `pnpm test:integration` | **0** | 330 pass / 0 fail / 1 skipped (сброс welcome_test + миграции 001–011) |
| test:e2e | `pnpm test:e2e` | **0** | 26 passed (1.2m) (Playwright chromium, next dev :3111, welcome_e2e + axe a11y) |
| build | `pnpm build` | **0** | Compiled successfully in 2.1s |
| scan:secrets | `pnpm scan:secrets` | **0** | scan:secrets ok — no secrets found in tracked files |

Сырые логи гейтов: `evidence/matrix/*.log`.

## Инкременты ПРЕДЫДУЩИХ прогонов (историческая справка, не часть этого инкремента)

| ID | Что | Коммит | Изменения | Тесты |
|---|---|---|---|---|
| WP1 | Реестр провайдеров, статус-резолвер, `GET /api/providers` | `03d210c` | src/domain/providers.ts (контракт §A2, таблица §A3: id/kind/auth/capabilities/direction/status/reason_code/setup{env,steps}; шаги — i18n-ключи, домен без текста), src/lib/provider-status.ts (telegram → TELEGRAM_BOT_TOKEN, email → RESEND_API_KEY; planned/disabled из реестра; только ИМЕНА переменных), публичный `/api/providers` (no-store, без сессии), i18n EN/RU/ES. | unit: providers (+9 — снимок реестра против §A3, инвариант direction, наличие i18n-ключей, ветки резолвера, отсутствие значений env в payload); integration: providers (+5 — анонимный 200, allowlist полей, честные статусы, no-store); живые чеки S1–S2. |
| WP2 | ICS-файл события, кнопки календаря/контактов, диплинки шэринга, og:url | `b57e7bb` | src/domain/ics.ts (RFC 5545: UTC DTSTART/DTEND, X-WR-TIMEZONE, стабильный UID `welcome-event-<id>@<host>`, CRLF-only, складывание по 75 октетов, экранирование с нейтрализацией CRLF-инъекции; online_link физически некуда положить), `GET /api/events/[id]/ics` (доступ как у страницы события, 404/409, no-store), кнопки на `/e/[slug]`, src/domain/share.ts + src/components/share-links.tsx (X/WhatsApp/Telegram/LinkedIn + navigator.share), og:url и vCard-кнопка на карточке. | unit: ics (+17 — экранирование/инъекция/UTC/UID/склад/whitelist/Google-ссылка) + share (+5); integration: ics (+5 — 200 + заголовки, 404, 409, комнатная ссылка не утекает, стабильный UID); e2e: interop (+2); живые чеки S3–S5, S10. |
| WP3 | Страница `/me/connections` | `78af9c1` | рендер реестра: карточка на провайдера (статус, причина, capabilities простыми словами, направление, `<details>` «как подключить» с шагами и ИМЕНАМИ переменных, кнопка действия только для живых), блок «что делаем / чего не делаем», запись в nav `/me/layout.tsx`, i18n EN/RU/ES (~40 ключей + названия и описания 15 провайдеров). Исправлен баг, найденный новым интеграционным тестом: `icsFilename` схлопывал `_` в `-` и переименовывал файл относительно события (generateEventSlug отдаёт base64url). | integration: connections (+5 — все id отрендерены, причина и имя переменной, значения env не попадают в HTML, гейт сессии); e2e: connections (+2 — из nav, статусы/раскрытие, redirect для анонима); живые чеки S9. |
| WP4 | Приватные цели профиля (каталог ≤3) | `88f8f25` | миграция 011 (profiles.goals text[] NOT NULL DEFAULT '{}' + GIN; НЕ дублируется в event_memberships — цели приватны), src/domain/goals.ts (16 целей с ru/en/es и паттернами для v4), валидация (каталог, ≤3, дедуп с сохранением первого места = приоритета), goals в POST/GET `/api/me/profile`, в `/api/taxonomy` (версия остаётся v3) и в GDPR-экспорте, пикер в `/me/profile` и на шаге 2 онбординга (в черновике — top-level, чтобы контракт `values` не менялся). | unit: goals (+8 — каталог, три локали, паттерны ссылаются на реальные id, валидация/порядок/лимит, форма payload, паритет i18n); integration: goals (+10 — схема и GIN, порядок round-trip, 400 на 4-ю и неизвестную, очистка, ПРИВАТНОСТЬ: нет в публичном JSON/vCard/HTML карточки, есть в экспорте, taxonomy аддитивна); e2e: goals (+1); живые чеки S6–S7. |
| WP5 | Matching v4: полезность, комплементарность, цели, 4 режима, две строки причин | `5f8018d` | src/domain/networking-score.ts (аддитивно: NETWORKING_ALGORITHM_V4, веса 0.30/0.20/0.25/0.15/0.10, матрица из 6 пар функций, intentFit с приоритетом намерения, complementarity = матрица ИЛИ взаимные needs×offers, goalAlignment по приватным целям, novelty против уже выбранных, recency — тайбрейкер вне формулы; гейт v3 + complementarity ≥ 0.25 для `useful`; чистая `rankCandidates`), src/domain/reasons-v4.ts (отдельный словарь, один код = одна строка), `GET .../recommendations?mode=useful\|grow\|similar\|explore` (+ `excluded_reason`), переключатель режимов и двухстрочные причины в UI. Только два оговорённых ассерта изменены (литерал algorithm в taxonomy-v3, allowlist в recommendations); парити-тест matching не тронут. | unit: networking-v4 (+23 — формула дословно, сумма весов = 1, матрица, приоритет, goalAlignment, novelty, детерминизм, recency как тайбрейкер, гейты, режимы, причины, v3 не изменился) + reasons-v4 (+8); integration: recommendations-v4 (+5 — четыре режима дают разные выдачи, коды двух строк, 400 на неизвестный режим, excluded_reason, allowlist, цели кандидата не читаются); e2e: matching-modes (+1); живые чеки S8. |
| WP6 | Полный прогон гейтов + скрипт `pnpm gates` | `1049039` | scripts/run-gates.mjs (7 гейтов последовательно, `evidence/final-gates.{json,log}`, предыдущий прогон сохраняется в `previous_run`); найден и исправлен флейк e2e (клик по nav сразу после OTP-редиректа гоняется с перерисовкой shell), обновлены скриншоты карточки. | 7/7 exit 0: unit 438 (было 366), integration 322 + 1 skip (293), e2e 24 (18). |
| WP7 | Новые чеки матрицы + живой прогон против прод-БД | `fda5c17` | Режим S в scripts/usage-matrix.mts (10 чеков: providers, ICS, goals, режимы рекомендаций, connections, карточка), `createEvent` умеет расписание и комнатную ссылку, `updateProfile` переносит goals. | 123 чека: 122 PASS / 0 FAIL / 1 SKIP (было 113: 112/0/1). |

## Исправления в ПРЕДЫДУЩИХ прогонах (историческая справка, не часть этого инкремента)

### BUG-2

- **Фикс:** src/infra/cleanup.ts: новый шаг 6a удаляет claim-челленджи ровно тех registrations, которые удаляет шаг 6b (то же 30-дневное окно, батчи ORDER BY id), до любого DELETE registrations; CHECK не ослаблен, миграции не тронуты.
- **Тесты:** tests/integration/cleanup.test.ts «cleanup: a live claim challenge never breaks the registration batch (BUG-2 regression)» — без 6a падает с 23514, с 6a проходит; claimed/young контроль не задет, второй проход идемпотентен.

### BUG-3

- **Фикс:** Промпт требует best-effort черновик всегда (в т.ч. из собственных полей) и строго один JSON; транспорт делает РОВНО один внутренний повтор при пустом ответе/неразбираемом теле (тот же запрос, тот же бюджет токенов, общий wall-clock бюджет 30с); маршрут отвечает 200 {ok, draft, sources: [], degraded: true} детерминированным черновиком из полей профиля (industry/job_function резолвятся через каталог), а не 502.
- **Тесты:** tests/unit/enrichment-degraded.test.ts (повтор ровно один, восстановление на втором ответе, 429/5xx/4xx без повтора, промпт, детерминированный fallback) + tests/integration/enrichment.test.ts «provider answers without a draft twice → 200 + degraded draft» (реальный транспорт против заглушки апстрима).

### BUG-4

- **Фикс:** Оба исхода маршрута enrich теперь пишут одну структурную строку console.error (provider/state/code/retryable) — без PII, без секретов, без тел запросов; клиент по-прежнему не получает деталей провайдера.
- **Тесты:** tests/integration/enrichment.test.ts «a real provider failure is still a 502 with a server-side trace (BUG-4)» — строка есть, содержит code=upstream_5xx и не содержит токена, имени проекта и имени профиля.

### R1

- **Фикс:** ?lang=en\|ru\|es на публичных страницах (/, /login, /p/*, /legal/*): src/proxy.ts валидирует параметр, форвардит x-welcome-locale и переписанный Cookie текущему рендеру (включая <html lang> в layout) и сохраняет выбор в cookie welcome_locale; невалидное значение игнорируется и не затирает сохранённую локаль. Подписанные разделы остались cookie-only.
- **Тесты:** tests/unit/locale-query.test.ts (резолвер + контракт прокси) + tests/e2e/smoke.spec.ts «?lang= switches the landing language and is remembered (R1)».

### Отклонения (API)

- **Фикс:** DELETE /api/me/contacts?kind=… (владелец, 400/404/200, значение никогда не эхоится) и GET /api/me (минимальная секретless-обёртка {ok, account}), которых не хватало по списку отклонений отчёта.
- **Тесты:** tests/integration/authz-negative.test.ts «contacts DELETE is session-scoped…» и «GET /api/me is owner-only, minimal and secretless».

## Найденные баги в ПРЕДЫДУЩИХ прогонах (все исправлены, историческая справка)

### BUG-1 — POST /api/auth/otp/request отвечал 500 при существующей строке accounts с той же email-хешом под другим auth_subject

- **Severity:** high · **Статус:** fixed
- **Repro:** INSERT INTO accounts (auth_subject, email_lookup_hash) VALUES ('alien:<hash>', '<hash>') для адреса, затем POST /api/auth/otp/request {email} → 500 internal_error (PostgresError 23505 accounts_email_lookup_hash_key). Живое подтверждение: строки в логах Vercel responseStatusCode:500 с этим constraint, найденные в ходе прогона мод A.
- **Доказательство:** Причина: `INSERT … ON CONFLICT (auth_subject) DO NOTHING` — у accounts ДВА уникальных индекса, второй конфликт не обрабатывался. Починено на `ON CONFLICT DO NOTHING` (src/app/api/auth/otp/request/route.ts) + регрессионный тест tests/integration/auth.test.ts ("otp request: account row under a different auth_subject does not 500"): без фикса тест падает (500), с фиксом проходит (200).
- **Рекомендация:** Задеплоить фикс: на живом деплое баг воспроизводится и у любого клиента с такой строкой login отдаёт 500.

### BUG-2 — Удаление registration с действующим claim-челленджем падает: ON DELETE SET NULL конфликтует с CHECK link_challenges_claim_shape_check

- **Severity:** medium · **Статус:** fixed
- **Repro:** DELETE FROM registrations WHERE id = <registration с link_challenges.purpose='registration_claim'>; → ERROR 23514 "new row for relation \"link_challenges\" violates check constraint \"link_challenges_claim_shape_check\"". Найдено при purge матрицы (первый прогон упал на этом шаге).
- **Доказательство:** db/migrations/003_link_challenges_claim.sql: CHECK ((purpose='registration_claim' AND registration_id IS NOT NULL AND account_id IS NULL) OR (purpose<>'registration_claim' AND registration_id IS NULL)); FK link_challenges.registration_id → registrations(id) ON DELETE SET NULL. Латентный риск в src/infra/cleanup.ts шаг 6 (DELETE FROM registrations для событий, закончившихся >30 дней назад): шаг 3 удаляет только челленджи, просроченные >30 дней, поэтому «свежий» claim-челлендж старого события ломает весь батч. ИСПРАВЛЕНО: шаг 6a (delete link_challenges по тому же предикату, drained до конца) выполняется до 6b; CHECK сохранён, схема не менялась. Регрессионный тест tests/integration/cleanup.test.ts «…(BUG-2 regression)»: без 6a — 23514 и fail, с 6a — pass; claimed/young регистрации и их челленджи не тронуты, повторный проход — no-op.
- **Рекомендация:** Достаточно 6a; перевод FK на ON DELETE CASCADE не нужен (он бы молча терял привязку челленджа вместо явного удаления).

### BUG-3 — Живой enrichment нестабилен: 502 enrichment_failed (мода F1 красная)

- **Severity:** medium · **Статус:** fixed
- **Repro:** POST /api/me/enrich с сессией аккаунта с профилем → 502 (code: enrichment_failed, retryable:true) за ~6.6с. Профиль БЕЗ своих ссылок — стабильно красный (4 вызова в двух прогонах). Профиль С website-ссылкой — плавающий: FAIL в двух прогонах, PASS (200 + draft) в третьем. Локальный repro тем же ключом/моделью: transport.enrich({links:[]}) → state=failed code=no_draft; transport.enrich({links:[website]}) → state=ok.
- **Доказательство:** Код провайдера в ответ не попадает (см. BUG-4), поэтому наблюдаемый факт — 502. Прямое измерение живого апстрима тем же ключом/моделью (2026-09-14): HTTP 200, finishReason STOP, grounded=true, но видимых частей нет (textLen=0, thoughts 248–400 и 3307 у трёх вызовов) — то есть бюджет НЕ исчерпан, модель периодически просто возвращает пустой видимый ответ. ИСПРАВЛЕНО в три слоя: (1) промпт требует best-effort черновик всегда и строго один JSON; (2) транспорт повторяет такой ответ ровно один раз с тем же бюджетом токенов (в живом прогоне повтор восстанавливает черновик); (3) если и повтор пуст, маршрут отдаёт 200 с детерминированным degraded-черновиком из полей профиля и флагом degraded:true — UI получает результат всегда, ничего не выдумано и не сохранено. Тесты: tests/unit/enrichment-degraded.test.ts, tests/integration/enrichment.test.ts («provider answers without a draft twice → 200 + degraded draft»).
- **Рекомендация:** Остаточный риск честно задокументирован: сам провайдер по-прежнему стохастичен (ручной LIVE-тест ENRICHMENT_LIVE=1 может не получить draft с первого-второго раза); контракт ручки теперь от него не зависит.

### BUG-4 — 502 enrichment_failed не оставляет серверного следа: код провайдера теряется

- **Severity:** low · **Статус:** fixed
- **Repro:** Сравнить: ответ 502 без кода провайдера + отсутствие записи в Vercel runtime logs с этим кодом (проверено vercel logs).
- **Доказательство:** src/app/api/me/enrich/route.ts: `return jsonError(502, 'enrichment_failed', …)` без console.error и без кода (`result.code`) — при этом клиенту код и не должен отдаваться (правильно), но в логи он обязан попадать. ИСПРАВЛЕНО: и degraded-, и failure-ветка пишут одну строку `[enrich] … provider=… state=… code=… retryable=…` (без PII, секретов и тел); тест tests/integration/enrichment.test.ts «…server-side trace (BUG-4)» проверяет наличие строки с code=upstream_5xx и отсутствие токена/имени проекта/имени профиля.
- **Рекомендация:** Готово; для алертинга по деградации искать `[enrich] degraded fallback`.

## Режим A

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| A1 | демо-вход через OTP + devCode (demo1) | 200 + сессия, GET /api/me 200 | OTP verify 200, cookie set, /api/me 200 | **PASS** | HTTP 200 {"ok":true,"profile":{"public_slug":"dFh7Eze5Dlr5SgXKDqH7ZQ","display_name":"Анна Смирнова","headline":"Product Designer","company":"Freelance","short_bio":"Дизайн интерфейсов и исследования … |
| A1b | вторая демо-личность (marta.demo) входит тем же путём | 200 + сессия | OTP+devCode → 200, приватная ручка 200 | **PASS** | HTTP 200 {"ok":true} |
| A2 | вход владельца через allowlist devCode | 200 + сессия | owner session ok ({"ok":true}) | **PASS** | HTTP 200 {"ok":true,"profile":{"public_slug":"1v-klDrM0Uw_fyvu7akQgg","display_name":"Nikita Berezniker","headline":"AI Transformation & Automation Lead · Barcelona","company":"2AI","short_bio":"Turns… |
| A3 | неверный код → 401 invalid_code (1 промах не блокирует) | 401 invalid_code, затем верный код 200 | 401 invalid_code → 200 ok | **PASS** | HTTP 401 {"code":"invalid_code","message":"Invalid or expired code","correlation_id":"«token»","retryable":false} \| HTTP 200 {"ok":true} |
| A4 | повторный запрос OTP в окне → 429 rate limit | 3 запроса ок, 4-й → 429 + Retry-After | 200,200,200 → 429 (Retry-After 900s) | **PASS** | HTTP 429 {"code":"rate_limited","message":"Too many codes requested. Try again later.","correlation_id":"«token»","retryable":true} retry-after=900 |
| A5 | сессия без cookie → 401 на приватных ручках | 401 unauthorized на 4 приватных GET | /api/me/profile:401 /api/me/contacts:401 /api/me/notes:401 /api/events/welcome-demo-meetup/directory:401 | **PASS** | /api/me/profile:401 /api/me/contacts:401 /api/me/notes:401 /api/events/welcome-demo-meetup/directory:401 |
| A6 | logout инвалидирует сессию | logout 200, затем GET приватной ручки 401 | 200 → logout 200 → GET /api/me/profile 401 | **PASS** | HTTP 200 {"ok":true} \| HTTP 401 {"code":"unauthorized","message":"Sign in required","correlation_id":"«token»","retryable":false} |
| A7 | CSRF: мутация с Origin: https://evil.example → 403 | 403 csrf_origin | 403 csrf_origin (same-origin 200) | **PASS** | HTTP 403 {"code":"csrf_origin","message":"Cross-origin request rejected","correlation_id":"«token»","retryable":false} \| control HTTP 200 {"ok":true,"action":"grant"} |
| A8 | enumeration: неизвестный email неотличим от известного | одинаковые ответы, без devCode | оба ответа идентичны: HTTP 200 {"ok":true} | **PASS** | unknown: HTTP 200 {"ok":true}<br>known(matrix-plain@welcome.test): HTTP 200 {"ok":true} |

## Режим B

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| B1 | MFA enroll: POST /api/me/mfa/totp | 200 + secret_base32/otpauth_uri/qr/recovery_codes(8) | enrolled: secret+otpauth+qr+8 recovery codes | **PASS** | HTTP 200 {"ok":true,"otpauth_uri":"otpauth://totp/WELCOME:matrix-mfa%40welcome.test?secret=«token»&issuer=WELCOME&algorithm=SHA1&digits=6&period=30"} |
| B2 | MFA confirm с неверным кодом → 400 | 400 mfa_invalid_code | 400 mfa_invalid_code | **PASS** | HTTP 400 {"code":"mfa_invalid_code","message":"Invalid or expired code","correlation_id":"«token»","retryable":false} |
| B3 | MFA confirm верным TOTP → 200 (полный цикл доступен) | 200 confirmed:true | 200 confirmed:true (TOTP посчитан локально) | **PASS** | HTTP 200 {"ok":true,"confirmed":true} |
| B4 | MFA disable без кода → 400; с верным кодом → 200 | 400 invalid_input, затем 200 enabled:false | 400 invalid_input → 400 mfa_invalid_code → 200 enabled:false | **PASS** | HTTP 400 {"code":"invalid_input","message":"A current TOTP code is required","correlation_id":"«token»","retryable":false} \| HTTP 400 {"code":"mfa_invalid_code","message":"Invalid or expired code","co… |
| B5 | полный TOTP-цикл покрыт integration-тестами | tests/integration/mfa.test.ts | цикл покрыт integration-набором: 8 MFA-подтест(ов) в evidence/matrix/integration.log; в матрице дополнительно выполнен живой enroll/confirm/disable по HTTP | **SKIP** | 8 MFA subtests in the integration run |
| B6 | активные сессии: список без токенов, текущая помечена | 200; ровно ключи id/created_at/last_seen_at/current; одна current и она первая; в теле нет слова token | сессий=36, current-первая=true, ключи строк только id/created_at/last_seen_at/current, токенов в теле нет | **PASS** | {"id":"fc4ed232-a06b-436b-898a-9288ef8f5b78","created_at":"2026-09-15T17:50:04.697Z","last_seen_at":"2026-09-15T17:50:04.697Z","current":true} |
| B7 | отзыв чужой сессии того же аккаунта: строка удаляется, cookie умирает | DELETE → 200 current_revoked=false; отозванная сессия → 401; строки в БД нет | отзыв → 200 current_revoked=false; отозванная сессия → 401; строка удалена; сессия-инициатор работает | **PASS** | HTTP 200 {"revoked":1,"current_revoked":false} \| HTTP 401 {"code":"unauthorized","message":"Sign in required","correlation_id":"«token»","retryable":false} |
| B8 | чужая сессия → 404 (не 403), битый id → 404, anon → 401 | чужая сессия не удаляется и не подтверждает своё существование | чужая сессия → 404 not_found (не 403) и остаётся живой; битый id → 404; anon GET/DELETE → 401 | **PASS** | HTTP 404 {"code":"not_found"} \| HTTP 404 {"code":"not_found"} \| HTTP 401 {"code":"unauthorized","message":"Sign in required","correlation_id":"«token»","retryable":false} \| HTTP 401 {"code":"unauthori… |

## Режим C

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| C1 | профиль: чтение с revision (число) | 200 + profile.revision:number | revision=1 | **PASS** | HTTP 200 {"ok":true} |
| C2 | профиль: обновление → revision++ | 200 + revision растёт на 1 | 1 → 2 | **PASS** | HTTP 200 {"ok":true,"revision":2} |
| C3 | профиль: устаревшая revision → 409 | 409 revision_conflict + x-current-revision | 409 revision_conflict (x-current-revision: 2) | **PASS** | HTTP 409 {"code":"revision_conflict","message":"Profile was changed by another request","correlation_id":"«token»","retryable":false} |
| C4 | профиль: неизвестная ось → 400 | 400 invalid_interests/invalid_industry | 400 invalid_interests + 400 invalid_industry | **PASS** | HTTP 400 {"code":"invalid_interests","message":"Unknown interests \"matrix-not-an-interest\". See GET /api/taxonomy for the catalogue.","correlation_id":"«token»","retryable":false} \| HTTP 400 {"code"… |
| C5 | профиль: >5 интересов → 400 | 400 invalid_interests | 400 invalid_interests (6 интересов) | **PASS** | HTTP 400 {"code":"invalid_interests","message":"at most 5 interests values are allowed (got 6)","correlation_id":"«token»","retryable":false} |
| C6 | профиль: >5 keywords → 400, ≤5 → 200 | 400 invalid_keywords, затем 200 | 400 invalid_keywords → 200 (5) | **PASS** | HTTP 400 {"code":"invalid_keywords","message":"at most 5 keywords are allowed (got 6)","correlation_id":"«token»","retryable":false} \| HTTP 200 {"ok":true,"revision":3} |
| C7 | контакты: CRUD + public_enabled (приватный телефон) | PUT 200, GET отдаёт оба, public_enabled сохраняется | website public, phone private, invalid_public_enabled → 400 | **PASS** | HTTP 200 {"ok":true} |

## Режим D

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| D1 | мини-лендинг GET /p/<slug>: 200 + имя/оси, без приватного телефона | 200, имя + метки интересов/интентов, не содержит телефон | 200; секции: interests«data-testid="pubcard-interests"> Interes…», needs«data-testid="pubcard-needs"> Looking for…», offers«data-testid="pubcard-offers"> …»; телефон отсутствует | **PASS** | {"interests":"data-testid=\"pubcard-interests\"> Interests AI / ML Dev tools <section class=\"mt-6 border-t border-line pt-5\"","needs":"data-testid=\"pubcard-needs\"> Looking for a co-founder <sectio… |
| D2 | публичная проекция /api/public/profiles/<slug>: только public-контакты | 200, contacts без phone | contacts=[website] | **PASS** | HTTP 200 {"slug":"«token»","display_name":"MATRIX-Alpha","contacts":[{"kind":"website","value":"https://matrix.example/alpha"}]} |
| D3 | vCard: 200, public-поля, без телефона, экранирование | text/vcard + escaped FN, без phone | text/vcard, FN экранирован (\, \;), phone отсутствует | **PASS** | FN:MATRIX-Alpha\, Inc.\; "Ltd" \| URL:https://matrix.example/alpha |
| D4 | QR SVG: 200 image/svg+xml | 200 + <svg | 200 image/svg+xml | **PASS** | HTTP 200 image/svg+xml; charset=utf-8 bytes=2468 |
| D5 | несуществующий slug → 404 (JSON и HTML) | 404 not_found | 404 JSON + 404 HTML + 404 vCard | **PASS** | HTTP 404 {"code":"not_found","message":"Profile not found","correlation_id":"«token»","retryable":false} \| HTML 404 |

## Режим E

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| E1 | таксономия: 16/94/14/12 | 200 intents=16 interests=94 functions=14 industries=12 | vv3: 16/94/14/12 | **PASS** | {"intents":16,"interests":94,"functions":14,"industries":12,"interest_groups":14} |
| E2 | валидация id таксономии при сохранении профиля | 200 с валидными id, 400 с неизвестным | валидные id → 200, неизвестный → 400 invalid_job_function | **PASS** | HTTP 200 {"ok":true,"revision":2} \| HTTP 400 {"code":"invalid_job_function","message":"Unknown job_function \"matrix-nope\". See GET /api/taxonomy for the catalogue.","correlation_id":"«token»","retry… |

## Режим F

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| F1 | enrichment: живой Vertex draft (профиль без своих ссылок) | 200 + draft/sources | 200 draft + 0 source(s), provider=vertex_gemini — черновик провайдера | **PASS** | #1: HTTP 200 {"ok":true,"draft":{"headline":"Professional Profile of MATRIX-Bravo","short_bio":"This is… |
| F1b | enrichment: живой Vertex draft при наличии ссылки (контроль) | 200 + draft/sources | 200 draft + 0 source(s), provider=vertex_gemini — черновик провайдера | **PASS** | #1: HTTP 200 {"ok":true,"draft":{"headline":"Founder & CEO in AI SaaS","short_bio":"MATRIX-Charlie is a… |
| F2 | enrichment: лимит 5/час → 429 | 6-й запрос → 429 (X-RateLimit-Limit: 5) | 400,400,400,400,400 → 429 (limit 5) | **PASS** | HTTP 429 {"code":"rate_limited","message":"Too many enrichment requests. Try again later.","correlation_id":"«token»","retryable":true} x-ratelimit-limit=5 |
| F3 | enrichment без сессии → 401 | 401 unauthorized | 401 unauthorized | **PASS** | HTTP 401 {"code":"unauthorized","message":"Sign in required","correlation_id":"«token»","retryable":false} |

## Режим G

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| G1 | публичное событие видно без сессии | GET /api/events/<slug> без cookie → 200 | 200 «WELCOME Demo Meetup — Product & Growth» (access_mode=public), viewer.is_member=false | **PASS** | HTTP 200 {"ok":true,"event":{"id":"«token»","slug":"welcome-demo-meetup","name":"WELCOME Demo Meetup — Product & Growth","mode":"offline","access_mode":"public","status":"active","starts_at":"2026-09-… |
| G2 | закрытое событие: join с кодом | без кода 403, неверный 403, верный 200, повтор идемпотентен | 403 join_forbidden (без кода) → 403 (неверный) → 200 (верный, state=active) → 200 already_member:true | **PASS** | HTTP 403 {"code":"join_forbidden","message":"This event requires a valid join code or registration claim","correlation_id":"«token»","retryable":false} \| HTTP 403 {"code":"join_forbidden","message":"T… |
| G3 | закрытое событие: 20 неверных попыток → lockout | после 20 фейлов верный код тоже 429 join_code_locked | 20× 403 join_forbidden (3× придержал per-IP bucket) → верный код 429 join_code_locked | **PASS** | HTTP 429 {"code":"join_code_locked","message":"Too many failed attempts. Try again later.","correlation_id":"«token»","retryable":true} retry-after=900 |
| G4 | directory: режимы intent/interest/all + фильтры + поиск q | 200 на все валидные, 400 на невалидные | all/intent/interest/function/industry/q → 200 (q=Bravo нашёл 1); невалидные → 400 invalid_mode / invalid_job_function | **PASS** | HTTP 200 {"ok":true,"mode":"all"} members=3 \| HTTP 400 {"code":"invalid_mode","message":"mode must be one of: all, intent, interest","correlation_id":"«token»","retryable":false} \| HTTP 400 {"code":"i… |
| G5 | recommendations: топ-3 + причины (коды и параметры) | 200, ≤3, reasons с code+params, без себя | 3/3: MATRIX-Delta(85), MATRIX-Bravo(85), MATRIX-Charlie(84); первый reason=intent_need_covered {"need":"seeking-cofounder","offer":"open-to-cofound"} | **PASS** | {"profile_id":"«token»","display_name":"MATRIX-Delta","headline":null,"company":null,"score":85,"mode":"useful","reasons_for_me":[{"code":"intent_need_covered","params":{"need":"seeking-cofounder","of… |
| G6 | attendance self-report | 200 attendance_source=self; чужая membership 403; мусор 400 | 200 attendance_source=self \| 403 forbidden (чужая) \| 400 invalid_present | **PASS** | HTTP 200 {"ok":true,"attendance_source":"self"} \| HTTP 403 {"code":"forbidden","message":"This membership does not belong to you","correlation_id":"«token»","retryable":false} \| HTTP 400 {"code":"inva… |
| G7 | non-member → 403 на directory/recommendations | 403 forbidden | 403 forbidden ×2 | **PASS** | HTTP 403 {"code":"forbidden","message":"Only active members can see the event directory","correlation_id":"«token»","retryable":false} \| HTTP 403 {"code":"forbidden","message":"Only active members can… |
| G8 | directory: смотрящий не показывается сам себе (все режимы) | alpha.profileId отсутствует в members для all/intent/interest | self отсутствует во всех трёх режимах (all=3, intent=0, interest=3); рекомендации тоже без себя (3) | **PASS** | alpha.profileId отсутствует в members: all=3, intent=0, interest=3; recommendations=3 |

## Режим H

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| H1 | import preview: counts, mapping и счётчики would_* | 200 с totalRows/…/sample + mapping + would_insert/would_update/would_skip/quarantined_count | totalRows=3, quarantined=1, would_insert=3, would_update=0, would_skip=0, mapping.name=name | **PASS** | {"sample":[{"name":"MATRIX-Import One","email":"matrix-claim@welcome.test","company":"MATRIX-Co","role":"founder","external_id":null,"approval_status":"approved"},{"name":"MATRIX-Import Two","email":"… |
| H2 | import commit | 200 counts{created,updated,skipped,quarantined} | created=3 updated=0 skipped=0 quarantined=1 | **PASS** | {"created":3,"updated":0,"skipped":0,"quarantined":1} |
| H3 | повторный commit идемпотентен (0 дублей) | created:0, число регистраций не растёт | created=0 updated=3; регистраций 3 → 3 | **PASS** | {"created":0,"updated":3,"skipped":0,"quarantined":1} |
| H4 | формула в данных безопасна (нейтрализация в экспорте) | экспорт CSV нейтрализует = в начале ячейки | ячейка экспортирована с защитным апострофом: «'=cmd\|' /C calc'!A0,unclaimed,approved» | **PASS** | '=cmd\|' /C calc'!A0,unclaimed,approved |
| H5 | лимиты импорта: >5000 строк и >5МБ отклоняются | 413 (приложение для строк; платформа для байт) | 5001 строка → 413 payload_too_large; >5МиБ → 413 (уровень платформы: Request Entity Too Large<br><br>«token»<br><br>cdg1::«token»<br>) | **PASS** | HTTP 413 {"code":"payload_too_large","message":"CSV exceeds the 5000-row limit","correlation_id":"«token»","retryable":false} \| HTTP 413 {"_nonJson":"Request Entity Too Large\n\«token»\n\ncdg1::«token… |
| H6 | неизвестный approval_status → quarantine (+ приглашение запрещено) | quarantined в БД; invite → 403 claim_not_allowed | approval_status='quarantined' в БД; invite → 403 claim_not_allowed | **PASS** | HTTP 403 {"code":"claim_not_allowed","message":"Quarantined registrations cannot be invited","correlation_id":"«token»","retryable":false} (status=quarantined) |
| H7 | ручной маппинг колонок меняет результат | без mapping: would_insert=0; с mapping: would_insert=2 и имена в БД | без mapping: would_insert=0; с mapping: would_insert=2 → commit created=2, имена из колонки Guest | **PASS** | HTTP 200 {"would_insert":0} \| HTTP 200 {"would_insert":2,"mapping":{"name":"Guest","email":"Contact","company":null,"role":null,"external_id":null,"approval_status":null}} \| HTTP 200 {"counts":{"creat… |
| H8 | невалидный маппинг → 400 с понятным кодом, без записи | unknown_mapping_field / unknown_csv_column / duplicate_mapping_field | nickname → 400 unknown_mapping_field; неизвестная колонка → 400 unknown_csv_column; два столбца на поле → 400 duplicate_mapping_field; headline+role → 400 (алиас) | **PASS** | HTTP 400 {"code":"unknown_mapping_field"} \| HTTP 400 {"code":"unknown_csv_column"} \| HTTP 400 {"code":"duplicate_mapping_field"} \| HTTP 400 {"code":"duplicate_mapping_field"} |

## Режим I

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| I1 | invite → claim-URL для approved-регистрации | 200 + claim_url/expires_at | 200 + claim_url=/claim/«token» (7 дней) | **PASS** | HTTP 200 {"ok":true,"claim_url":"/claim/«token»","expires_at":"2026-09-22T17:53:11.502Z"} |
| I2 | GET /claim/<token> НЕ консюмит (повторный GET работает) | два GET → 200, challenge не consumed | GET ×2 → 200; consumed_at остался NULL | **PASS** | HTTP 200/200, link_challenges.consumed_at = null |
| I3 | claim с чужого email → 403 | 403 email_mismatch | 403 email_mismatch | **PASS** | HTTP 403 {"code":"email_mismatch","message":"This claim link belongs to a different email address","correlation_id":"«token»","retryable":false} |
| I4 | claim с правильным email → 200 (+membership) | 200 + membership state active | 200: membership active, profile_created=false | **PASS** | HTTP 200 {"ok":true,"event_id":"«token»","membership":{"id":"«token»","state":"active","directory_visible":false},"profile_created":false,"notice":"Данные из регистрации — проверьте, что всё верно. Им… |
| I5 | повторный claim → 409 already_used (один победитель) | 409 already_used | 409 already_used | **PASS** | HTTP 409 {"code":"already_used","message":"This claim link has already been used","correlation_id":"«token»","retryable":false} |

## Режим J

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| J1 | intro create (событийный контекст) | 200 already_existed:false + id; инициатор уже accept (implicit_by_initiation) | 200 pending, already_existed=false; у инициатора my_decision=accept, other_accepted=false | **PASS** | HTTP 200 {"ok":true,"introduction":{"id":"«token»","state":"pending","profile_a":"«token»","profile_b":"«token»","context_key":"event:«token»"},"already_existed":false} \| HTTP 200 {"ok":true,"introduc… |
| J2 | intro create идемпотентен (повтор → тот же id) | 200 already_existed:true, same id | 200 already_existed=true, тот же id, одна строка пары | **PASS** | HTTP 200 {"ok":true,"already_existed":true} |
| J3 | respond decline + нейтральное уведомление инициатору | decline 200; state declined виден обеим сторонам; джоба intro_declined без причины | decline → 200; у обеих сторон state=declined; джоба intro_declined_notice для alpha, текст нейтральный | **PASS** | HTTP 200 {"ok":true,"introduction":{"id":"«token»","state":"declined","my_decision":"decline"}} \| HTTP 200 {"ok":true,"introduction":{"id":"«token»","state":"declined","my_decision":"accept","other_ac… |
| J4 | mutual после ОДНОГО accept контрагента | charlie accept → mutual; reveal = пересечение полей | pending → mutual после ОДНОГО accept контрагента; revealed=[phone: +34600999888] при public_enabled=false | **PASS** | HTTP 200 {"ok":true,"introduction":{"id":"«token»","state":"pending","my_decision":"accept","other_accepted":false},"revealed":[]} \| HTTP 200 {"ok":true,"introduction":{"id":"«token»","state":"mutual"… |
| J5 | отзыв полей → reveal скрывается | после re-accept с reveal_fields=[] → revealed=[] | revealed=[] после сужения пересечения полей | **PASS** | HTTP 200 {"ok":true,"introduction":{"id":"«token»","state":"mutual","my_decision":"accept","other_accepted":true},"revealed":[]} |
| J6 | блокировка: reveal подавлен и интро невозможно | GET reveal=[] при mutual; create → 403 blocked | revealed=[] (state mutual) + create → 403 blocked | **PASS** | HTTP 200 {"ok":true,"introduction":{"id":"«token»","state":"mutual","my_decision":"accept","other_accepted":true},"revealed":[]} \| HTTP 403 {"code":"blocked","message":"Introduction is not available",… |
| J7 | cooldown: пара с интро не в рекомендациях | Bravo исчез из рекомендаций после decline | до интро Bravo был в рекомендациях (3 шт.), после decline отсутствует; сейчас 1 шт. | **PASS** | before=[MATRIX-Delta, MATRIX-Bravo, MATRIX-Charlie], after=[1] |
| J8 | блокировка: нет в directory и рекомендациях | Charlie отсутствует в обоих списках | Charlie отсутствует в directory (2 записей) и рекомендациях (1) | **PASS** | members=2, recommendations=1, blocked=Charlie |
| J9 | respond withdraw (отзыв до mutual) + нейтральное уведомление контрагенту | 200 state revoked; джоба intro_withdrawn без причины, ровно одна | withdraw → 200 revoked (повтор → 409); джоба intro_withdrawn_notice для delta, текст нейтральный, ровно одна | **PASS** | HTTP 200 {"ok":true,"introduction":{"id":"«token»","state":"revoked","my_decision":"withdraw"}} \| HTTP 409 {"code":"invalid_state","message":"This introduction is revoked; only pending introductions c… |
| J10 | уведомления о решении подавляются по правилам (no_channel / consent_revoked) | decline → suppressed:no_channel; withdraw при активном binding без service_channel-согласия → suppressed:consent_revoked | decline=suppressed:no_channel (нет канала), withdraw=suppressed:consent_revoked (binding активен, согласие отозвано) | **PASS** | delivery_attempts: intro_declined:4b58f38f-1f65-4bf0-b8d2-76ea835b75c5:7426e7f2-e00f-4d37-97a9-90ed31e73c96 → suppressed/no_channel; intro_withdrawn:6691345b-5b49-47f7-9c98-94621cd2429b:8aee0d44-7f00-… |
| J11 | email-канал уведомлений: выбор канала и подавление | без привязки + email + согласие → email (не no_channel); с активной привязкой → telegram (email не используется); email без согласия → suppressed:consent_revoked; адрес не хранится в джобе | mailOnly=sent:email (провайдера у экземпляра нет — подавление честное, канал всё равно email, не no_channel); mailBound=failed:tg_http_400 (telegram приоритетнее); mailNoConsent=suppressed:consent_revoked | **PASS** | delivery_attempts: intro_requested:f8544254-91d4-49ba-9808-afb068201264:b3995447-ec62-4f0e-bf7c-432a85de3b1d → sent:email; intro_requested:da2b5c18-96c7-4af3-bc2a-541f6967966a:6ba8d834-48c7-4d77-bada-… |

## Режим K

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| K1 | заметка владельцем: upsert + список | 200; заметка видна в своём списке | 200 + заметка в /api/me/notes | **PASS** | HTTP 200 {"ok":true,"note":{"other_profile_id":"«token»","note_text":"MATRIX- note about Delta","next_step":"ping","next_step_status":"proposed","updated_at":"2026-09-15T17:53:17.393Z"}} |
| K2 | чужая заметка не видна другому аккаунту | список Bravo не содержит заметку Alpha | список Bravo: 0 заметок, чужих нет | **PASS** | HTTP 200 {"ok":true} notes=0 |
| K3 | организатор без связи → 403 | 403 not_connected | organizer → 403 not_connected; self → 400 self_note | **PASS** | HTTP 403 {"code":"not_connected","message":"Notes can only be kept about people you actually met","correlation_id":"«token»","retryable":false} \| HTTP 400 {"code":"self_note","message":"Notes are abou… |

## Режим L

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| L1 | grant по purpose (event scope) | 200 action=grant | 200 grant organizer_marketing@event | **PASS** | HTTP 200 {"ok":true,"action":"grant","purpose":"organizer_marketing","scope_type":"event"} |
| L2 | withdraw по purpose (revoke-ручка) | 200 action=withdraw | 200 withdraw; неизвестный purpose → 400 invalid_purpose | **PASS** | HTTP 200 {"ok":true,"action":"withdraw"} \| HTTP 400 {"code":"invalid_purpose","message":"purpose must be one of: public_card, event_directory, introduction_fields, service_channel, organizer_marketing… |
| L3 | withdraw подавляет уже поставленные в очередь джобы (интро) | pending-джоба становится suppressed | джоба intro_requested…: suppressed → suppressed | **PASS** | outbox_jobs.status suppressed → suppressed (purpose=service_channel, account=Bravo) |
| L4 | export содержит историю согласий | консенты grant+withdraw присутствуют в export | export.consents: 5 записей (grant+withdraw organizer_marketing) | **PASS** | [{"purpose":"organizer_marketing","scope_type":"event","scope_id":"cd99fb95-86b1-424e-a029-56d3c7307e2f","field_set":[],"policy_version":"matrix-2026-09-14","action":"grant","created_at":"2026-09-15T1… |

## Режим M

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| M1 | export JSON: полнота (профиль, контакты, интро, согласия, заметки) | 200 + все секции непусты | секции: contacts=2, consents=7, memberships=2, introductions=6, notes=1 | **PASS** | {"keys":["exported_at","policy_version","profile","contacts","consents","memberships","introductions","notes","blocks","reports","disclosure"],"contacts":2,"notes":1} |
| M2 | delete аккаунта (soft → deleting) и данные перестают отдаваться | 400 на неверный confirm; 200 → 401 на ручках и 404 на карточке | 400 confirm_mismatch → 200 deleted:true; 401 на /api/me/profile, 404 на карточке, status='deleting' | **PASS** | HTTP 400 {"code":"confirm_mismatch","message":"The typed name does not match","correlation_id":"«token»","retryable":false} \| HTTP 200 {"ok":true,"deleted":true} \| HTTP 404 {"code":"not_found","messag… |
| M3 | blocks: block/unblock через API + эффект в directory | already_blocked false→true; was_blocked true; профиль скрыт | block 200 (false) → повтор (true) → невидим в directory → unblock 200 (true); self_block 400 | **PASS** | HTTP 200 {"ok":true,"already_blocked":false} \| HTTP 200 {"ok":true,"already_blocked":true} \| HTTP 200 {"ok":true,"was_blocked":true} |
| M4 | reports: 201 open, валидация reason и self | 201 open; 400 invalid_reason; 400 self_report | 201 open → 400 invalid_reason → 400 self_report | **PASS** | HTTP 201 {"ok":true,"report":{"id":"«token»","status":"open"}} \| HTTP 400 {"code":"invalid_reason","message":"reason must be one of: spam, harassment, inappropriate, other","correlation_id":"«token»",… |

## Режим N

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| N1 | create draft кампании (owner) | 201 state=draft | 201 draft (content_revision=1) | **PASS** | HTTP 201 {"ok":true,"campaign":{"id":"«token»","event_id":"«token»","purpose":"service_channel","state":"draft","content_revision":"1","approved_revision":null}} |
| N2 | audience preview: count + channel_ready | 200 audience.count >= 1 | count=4, channel_ready=1, sample=4 | **PASS** | HTTP 200 {"ok":true,"audience":{"count":4,"channel_ready":1,"sample":[{"display_name":"MATRIX-Alpha, Inc.; \"Ltd\""},{"display_name":"MATRIX-Bravo"},{"display_name":"MATRIX-Charlie"},{"display_name":"… |
| N3 | approve (owner, MFA step-up не требуется — фактор не подтверждён) | 200 state=approved, approved_revision=content_revision | 200 approved (approved_revision=1, снимок аудитории заморожен) | **PASS** | HTTP 200 {"ok":true,"campaign":{"id":"«token»","state":"approved","content_revision":1,"approved_revision":1},"audience_count":4} |
| N4 | staff не может create/approve/send/stats кампании | 403 forbidden на всех четырёх | 403 forbidden ×4 (staff) | **PASS** | HTTP 403 {"code":"forbidden","message":"Only the organizer owner can approve campaigns","correlation_id":"«token»","retryable":false} \| HTTP 403 {"code":"forbidden","message":"Only the organizer owner… |
| N5 | edit после approve сбрасывает approved_revision | 200 state=draft, content_revision+1, approved_revision=null | approved_revision 1 → null, content_revision 1 → 2 | **PASS** | HTTP 200 {"ok":true,"campaign":{"id":"«token»","state":"draft","content_revision":2,"approved_revision":null}} |
| N6 | re-approve после правки | 200 approved с новой ревизией | 200 approved (approved_revision=2) | **PASS** | HTTP 200 {"ok":true,"campaign":{"id":"«token»","state":"approved","content_revision":2,"approved_revision":2},"audience_count":4} |
| N7 | send → 202 + джобы | 202 queued >= 1, state=running | 202 queued=4, state=running | **PASS** | HTTP 202 {"ok":true,"campaign_id":"«token»","queued":4,"state":"running"} |
| N8 | stats по статусам доставки | 200 counters со всеми 8 ключами | counters={"pending":4,"leased":0,"sent":0,"delivered":0,"failed":0,"unknown":0,"suppressed":0,"cancelled":0}, queued_total=4 | **PASS** | {"counters":{"pending":4,"leased":0,"sent":0,"delivered":0,"failed":0,"unknown":0,"suppressed":0,"cancelled":0},"queued_total":4} |
| N9 | withdraw согласия получателя → джоба suppressed (кампания) | outbox job получателя становится suppressed | джоба кампании для Alpha: pending → suppressed | **PASS** | outbox_jobs.status pending → suppressed; аккаунт остался в снимке аудитории, отправка подавлена |
| N10 | сегмент кампании отбирает только подходящих участников | без сегмента 2 подходящих, с сегментом need_intents=seeking-cofounder — 1; в ответе есть применённый filter | без сегмента 2 → с сегментом 1 (MATRIX-Alpha, Inc.; "Ltd") | **PASS** | HTTP 200 {"audience":{"count":2,"channel_ready":0,"sample":[{"display_name":"MATRIX-Alpha, Inc.; \"Ltd\""},{"display_name":"MATRIX-Bravo"}],"filter":{"need_intents":[],"offer_intents":[],"interests":[… |
| N11 | сегмент кампании: счётчик превью == число созданных джоб при send | audience_count при approve = count превью = queued при send | preview=1, approve audience_count=1, snapshot=1, queued=1, джоб=1 | **PASS** | HTTP 200 {"audience":{"count":1,"channel_ready":0,"sample":[{"display_name":"MATRIX-Alpha, Inc.; \"Ltd\""}],"filter":{"need_intents":["seeking-cofounder"],"offer_intents":[],"interests":[],"job_functi… |
| N12 | сегмент кампании: невалидный каталог-ид → 400 (ничего не расширяется) | create/edit/override с неизвестным id → 400 invalid_* | create → 400, override → 400 invalid_audience_filter, edit → 400; сохранённый сегмент не изменился | **PASS** | HTTP 400 {"code":"invalid_interests","message":"Unknown interests \"not-a-topic\". See GET /api/taxonomy for the catalogue.","correlation_id":"«token»","retryable":false} \| HTTP 400 {"code":"invalid_a… |
| N13 | воронка события: агрегаты без PII для владельца | 200 со всеми 10 метриками и by_day из 30 дней | members_active=8, intros_requested=6, mutual=1, declined=1, by_day=30 дн. | **PASS** | {"registrations_total":8,"registrations_claimed":4,"members_active":8,"members_directory_visible":7,"intros_requested":6,"intros_mutual":1,"intros_declined":1,"reveals_total":0,"notes_created":1,"atte… |
| N14 | воронка события: 403 для staff и чужого организатора, 401 без сессии | staff → 403, организатор чужого события → 403, anon → 401, несуществующий id → 403 | staff=403, чужой организатор=403, anon=401, неизвестное событие=403 | **PASS** | HTTP 403 {"code":"forbidden","message":"Only the organizer owner or admin can read event analytics","correlation_id":"«token»","retryable":false} \| HTTP 403 {"code":"forbidden","message":"Only the org… |
| N15 | печатный лист QR-бейджей: имена и QR-цели есть, email/телефонов нет | 200; бейдж на каждую печатаемую регистрацию, quarantined не печатается, data-qr-url на карточку/страницу события, ни одного email | лист 200, бейджей 7 = печатаемых регистраций 7, quarantined (1) не напечатаны, QR-цели /p/ и /e/matrix-event-a-15be59e на месте, email/телефонов в HTML нет | **PASS** | HTTP 200, html 59837 байт, имена: MATRIX-Claim, MATRIX-MailEcho, MATRIX-MailFox |
| N16 | бейджи: чужие не видят лист, API ссылок закрыт | страница чужому → страница 403 без данных; badge-links: staff → 403, чужой организатор → 403, anon → 401 | staff/чужой организатор получают страницу 403 без данных; API badge-links: staff=403, чужой=403, anon=401 | **PASS** | HTTP 403 {"code":"forbidden","message":"You do not manage this event","correlation_id":"«token»","retryable":false} \| HTTP 403 {"code":"forbidden","message":"You do not manage this event","correlation… |
| N17 | claim-ссылки для бейджей: только unclaimed без карантина, CSV без PII, токен хранится хешем | 200; все ссылки — unclaimed/не-quarantine; у quarantined ссылки нет; в CSV нет email и имён | выпущено 3 ссылок только для unclaimed/не-quarantine; у quarantined ссылки нет; токен в БД только хешем; CSV = registration_id,claim_url без PII | **PASS** | HTTP 200, issued=3, csv 390 байт, строк 4 |

## Режим O

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| O1 | webhook без секрета → 401 | 401 unauthorized_webhook, без побочных эффектов | 401 unauthorized_webhook (без секрета и с неверным) | **PASS** | HTTP 401 {"code":"unauthorized_webhook","message":"Invalid webhook secret","correlation_id":"«token»","retryable":false} \| HTTP 401 {"code":"unauthorized_webhook","message":"Invalid webhook secret","c… |
| O2 | дубликат update_id → 200 accepted:false | первый accepted:true, дубль accepted:false | accepted:true → accepted:false (идемпотентность по update_id) | **PASS** | HTTP 200 {"ok":true,"accepted":true} \| HTTP 200 {"ok":true,"accepted":false} |
| O3 | устаревший update (date > 24ч) → 400 stale_update | 400 stale_update | 400 stale_update (окно 24ч) | **PASS** | HTTP 400 {"code":"stale_update","message":"Update is older than the accepted window","correlation_id":"«token»","retryable":false} |
| O4 | известная привязка (владелец) + /help → ответ доставлен | 200 accepted:true; telegram_reply переходит в sent | 200 accepted:true; telegram_reply → sent (attempt 1) | **PASS** | outbox_jobs(kind=telegram_reply, owner) status=sent; tick processed the update and the reply |
| O5 | MATRIX-привязка + /stop → binding revoked и последующие автосообщения suppressed | binding state=revoked; новое автосообщение suppressed | /stop → 200; binding state=revoked; сообщение после отзыва → suppressed | **PASS** | channel_bindings.state=revoked; pre-stop job=failed (мог быть подхвачен cron до отзыва), post-stop job=suppressed (подавлено воркером) |
| O6 | /start с валидным токеном без web-confirm → привязка НЕ создаётся | нет binding; после confirm → binding создаётся | /start без confirm → 0 привязок; после confirm + /start → active (тот же аккаунт) | **PASS** | HTTP 201 {"ok":true,"deep_link":"https://t.me/«secret»?start=«token»","next":"Confirm the link in this web session, then send /start with the link in Telegram."} \| HTTP 200 {"ok":true} |
| O7 | worker-tick только с секретом | без секрета 401; с секретом 200 processed | 401 без секрета → 200 processed=0 | **PASS** | HTTP 401 {"code":"«token»","message":"Invalid worker tick secret","correlation_id":"«token»","retryable":false} \| HTTP 200 {"ok":true,"processed":0,"requeued_leases":0} |

## Режим P

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| P1 | health публичный: без migration_version | 200 status/db/worker и БЕЗ migration_version | 200 {"status":"ok","db":"up","worker":"up"} (без migration_version) | **PASS** | HTTP 200 {"status":"ok","db":"up","worker":"up"} |
| P2 | health с x-health-details: отдаёт версию миграций | 200 + migration_version | 200 migrations=applied, migration_version=011 | **PASS** | HTTP 200 {"status":"ok","db":"up","migrations":"applied","migration_version":"011","worker":"up"} |
| P3 | security-заголовки на / и /login (4 заголовка) | CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy | 4/4 на / и /login (content-security-policy, x-frame-options, referrer-policy, permissions-policy) | **PASS** | /: 4/4 \| /login: 4/4 |
| P4 | rate limit на OTP: per-IP bucket (10/мин) | 11-й запрос с одного IP → 429 + X-RateLimit-Limit | статусы 200,200,200,200,200,200,200,200,200,429 → 429 (X-RateLimit-Limit=10) | **PASS** | HTTP 429 {"code":"rate_limited","message":"Too many requests. Slow down and try again later.","correlation_id":"«token»","retryable":true} x-ratelimit-limit=10 |
| P5 | приватные GET → cache-control: no-store | no-store на /api/me/profile и /api/me/notes | /api/me/profile: no-store, private \| /api/me/notes: no-store, private | **PASS** | /api/me/profile: no-store, private \| /api/me/notes: no-store, private |
| P6 | worker-tick: оба носителя секрета (header и Bearer) | 200 на x-worker-tick-secret и Authorization: Bearer | header 200, Bearer 200, ?secret= 401 (носитель удалён) | **PASS** | HTTP 200 {"ok":true,"processed":0} \| HTTP 200 {"ok":true,"processed":0} \| HTTP 401 {"code":"«token»","message":"Invalid worker tick secret","correlation_id":"«token»","retryable":false} |

## Режим Q

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| Q1 | staff не может approve/send (повтор на том же объекте) | 403 forbidden | 403 forbidden ×2 (role-проверка раньше проверки состояния) | **PASS** | HTTP 403 {"code":"forbidden","message":"Only the organizer owner can approve campaigns","correlation_id":"«token»","retryable":false} \| HTTP 403 {"code":"forbidden","message":"Only the organizer owner… |
| Q2 | кросс-тенант: организатор B не читает данные A | 404 на кампанию A (анти-энумерация), 403 на события/каталог A | кампания A → 404 not_found (скрытие существования), export A → 403, directory A → 403; своё событие B → 200 | **PASS** | HTTP 404 {"code":"not_found","message":"Campaign not found","correlation_id":"«token»","retryable":false} \| HTTP 403 {"code":"forbidden","message":"You do not manage this event","correlation_id":"«tok… |

## Режим R

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| R1 | /?lang=ru\|en\|es переключает язык | ожидание задания: строки языка по query-параметру | ?lang=ru → ru, ?lang=es → es, ?lang=en → en; ?lang=de → en (игнорируется, cookie не перезаписан) | **PASS** | ?lang=ru → ru \| ?lang=es → es \| ?lang=en → en \| cookie welcome_locale сохранён для каждого валидного значения |
| R2 | фактическая механика локали: cookie → локализованные строки | ru/es отдают свои строки, en — свои | en«permanent» / ru«Постоянный» / es«reunión» — все найдены на страницах | **PASS** | {"en":"permanent","ru":"Постоянный","es":"reunión"} |
| R3 | мини-лендинг на 360px без горизонтального overflow (Playwright) | scrollWidth <= 361 при viewport 360 | 360px: scrollWidth=360 (clientWidth=360) — overflow нет | **PASS** | {"scrollWidth":360,"clientWidth":360,"bodyScrollWidth":360} |

## Режим S

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| S1 | GET /api/providers публично отдаёт реестр без сессии | 200, 15 провайдеров в порядке §A3, no-store | 200, 15 провайдеров, Cache-Control no-store, session не нужна | **PASS** | HTTP 200 {"providers":[{"id":"telegram","kind":"channel","auth":"bot","capabilities":["send","receive","deeplink"],"direction":"both","status":"live","reason_code":null,"missing_env":[],"env":["TELEGR… |
| S2 | статусы провайдеров честны: live ⇒ без reason/missing_env, disabled ⇒ not_configured + имя переменной | telegram/email по факту env, planned/disabled из реестра, только ИМЕНА переменных | telegram=live, email=live(honesty-only), ics=planned, linkedin=disabled(policy_restricted), vcard=live | **PASS** | HTTP 200 {"providers":[{"id":"telegram","kind":"channel","auth":"bot","capabilities":["send","receive","deeplink"],"direction":"both","status":"live","reason_code":null,"missing_env":[],"env":["TELEGR… |
| S3 | GET /api/events/<slug>/ics — публичный календарный файл | 200 text/calendar, attachment, UID, UTC, без комнатной ссылки | 200, text/calendar, attachment, DTSTART UTC, UID по id события, комнатная ссылка отсутствует | **PASS** | content-type=text/calendar; charset=utf-8 disposition=attachment; filename="welcome-matrix-ics-e713b00.ics" bytes=411 |
| S4 | ICS: 404 на несуществующее событие, 409 без расписания | 404 not_found; 409 no_schedule | 404 на отсутствующее событие, 409 + no_schedule без starts_at | **PASS** | HTTP 404 {"code":"not_found"} \| HTTP 409 {"code":"no_schedule"} |
| S5 | страница /e/<slug>: кнопки календаря и диплинки шэринга | есть ссылка на .ics, Google Calendar и 4 сети с rel=noopener noreferrer | .ics + Google Calendar + 4 сети, 5 ссылок с rel="noopener noreferrer" | **PASS** | HTTP 200, 17169 bytes |
| S6 | цели профиля: сохраняются в порядке приоритета и приватны | GET возвращает тот же порядок; целей нет ни в карточке, ни в vCard | find-cofounder → fundraise → grow-network сохранены и прочитаны в том же порядке; в публичном JSON и vCard целей нет | **PASS** | HTTP 200 {"profile":{"public_slug":"«token»","display_name":"MATRIX-Alpha, Inc.; \"Ltd\"","headline":"Matrix run","company":null,"short_bio":null,"languages":[],"offer_tags":[],"need_tags":[],"need_in… |
| S7 | цели: каталог в /api/taxonomy (v3 + goальs) и 400 на четвёртую/неизвестную | version v3, 16 целей, limits.goals=3; 400 invalid_goals | taxonomy: v3 + 16 целей + limits.goals=3; 400 invalid_goals на 4 цели и на неизвестную; список не затёрт | **PASS** | HTTP 200 {"version":"v3","limits":{"need_intents":3,"offer_intents":3,"interests":5,"keywords":5,"keyword_length":40,"goals":3}} \| HTTP 400 {"code":"invalid_goals"} \| HTTP 400 {"code":"invalid_goals"} |
| S8 | GET .../recommendations?mode= — четыре режима и 400 на неизвестный | все 4 → 200 с эхом mode; unknown → 400 invalid_mode; есть v4-строки причин | useful=1, grow=1, similar=1, explore=1; unknown → 400 invalid_mode; v4-строки причин присутствуют | **PASS** | useful=1, grow=1, similar=1, explore=1 \| HTTP 400 {"code":"invalid_mode"} |
| S9 | /me/connections: закрыт без сессии, с сессией показывает провайдеров без секретов | signed-out → redirect /login; signed-in → 200 + все id + только ИМЕНА переменных | signed-out 307 → /login; signed-in 200 с 15 карточками, панелью импорта и именами переменных | **PASS** | signed-out: 307 /login \| signed-in: HTTP 200, 95103 bytes |
| S10 | публичная карточка: og:url, «Добавить в контакты» и диплинки | og:url карточки, ссылка на vCard без сессии, 4 сети | 200: og:url + vCard + 4 сети, анонимная выгрузка .vcf работает, приватных целей нет | **PASS** | HTTP 200, 19943 bytes \| vCard HTTP 200 |
| S11 | POST /api/me/contacts/import: fixture-сосед находится по адресу из .vcf | 200, matched по slug, в теле нет ни одного email, 5/час | 200: scanned=2, matched=1 (MATRIX-Bravo / matrix-bravo-35855dfc42319231), unmatched=1, ни одного email в ответе | **PASS** | HTTP 200 {"ok":true,"scanned":2,"matched_count":1,"unmatched_count":1} \| X-RateLimit-Limit=5 |
| S12 | импорт ничего не сохраняет: снимок всех таблиц до/после, плюс только факт в audit_events | ни одна таблица хранения не изменилась; адрес не появился ни одним хешем; в audit — ровно один факт этого аккаунта | таблиц проверено: 18, изменений в таблицах хранения: 0; хешей импортированного адреса в БД: 0; audit_events: +1 факт (format, matched_count, scanned, skipped) | **PASS** | snapshot={"tables":18,"changed":0,"unknownHashRows":0} \| audit={"format":"vcard","scanned":2,"skipped":0,"matched_count":1} |
| S13 | импорт: 401 без сессии и 429 на шестой запрос в час (пер-аккаунтный бюджет) | anon → 401; 5 запросов 200 → шестой 429 + Retry-After; другой аккаунт не задет | anon 401 unauthorized; подряд: 200, 200, 200, 200, 200 → 429 rate_limited (Retry-After=720s); другой аккаунт 200 | **PASS** | HTTP 401 {"code":"unauthorized"} \| HTTP 429 {"code":"rate_limited"} \| Retry-After=720 \| other=200 |

## Отклонения от ожиданий задания

- F2: квота тратилась аккаунтом без профиля (400 profile_required), чтобы не жечь живые Vertex-вызовы; порядок проверок (квота раньше профиля) подтверждён.
- G2: ожидание задания «403/429 после 20 попыток lockout» проверено отдельной строкой G3 на выделенном событии (lockout блокирует и верный код — совместно на одном событии не сходится).
- G5: позитивный контроль: Bravo/Charlie/Delta видны до интро; отсутствие пары с активным интро проверяется в J7
- H5: тело >~4.5МБ отклоняет сама платформа Vercel до входа в функцию, поэтому прикладной лимит 5МиБ на этом деплое недостижим: отказ есть (413), но на платформенном слое, с другим телом ответа.
- L4: ключ называется `consents`, а не `consent_events` как в задании; содержимое — append-only история согласий.
- N16: страница /badges отдаёт страницу-заглушку 403 с HTTP 200 — это общая конвенция организаторских страниц (то же у /organizer/events/[eventId] и аналитики); статус-код 403 даёт только API. Проверяем фактическое поведение: отказ есть, данные не утекают.
- O5: /stop выполнен на синтетической MATRIX-привязке, а не на реальной привязке владельца: отзыв реальной привязки — деструктивная операция с существующими данными (запрещена заданием вне режима «проверить отказ»). /help на реальной привязке владельца проверен в O4.

## Созданные / удалённые MATRIX-сущности

Создано за прогон: 18 аккаунтов, 17 профилей, 7 событий, 2 организаторов, 2 кампаний. Все имена — с префиксом `MATRIX-` (display_name, названия событий и организаторов, body кампаний), слаги — `matrix-…`.

Cleanup:
- outbox_jobs removed: 17; audit_events unlinked (actor → NULL, как в собственном cleanup приложения)
- accounts hard-deleted: 28/28 (каскадом — profiles, contacts, memberships, consents, sessions, challenges, mfa, blocks, reports)
- link_challenges (registration_claim) removed before their registrations: 4
- organizers hard-deleted: 2 (каскадом — events, campaigns, registrations, memberships, introductions)


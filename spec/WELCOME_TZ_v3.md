# WELCOME — Consolidated Technical Specification v3.0
**Research freeze:** 2026-09-07 · **Implementation target:** AutoClaw primary + external evidence/release gates
> This consolidated document mirrors the modular source-of-truth files in the archive. If a section conflicts with an older v2 artifact under `legacy/`, the V3 modular file wins.


---

# Executive / Start

**Implementation-ready package for AutoClaw + external QA/release gates**  
Research freeze: **2026-09-07, Europe/Madrid**. Working product name; domain/trademark availability not verified.

## 0. What this archive is
This is not only a product brief. It is a handoff package that lets an implementation agent create, test, stage and — only with real credentials and explicit release permission — deploy WELCOME.

WELCOME is a **persistent personal networking profile + reusable QR**. Events add context, attendee imports, matching and follow-up; the profile remains useful after the event. Browser is the universal surface. Telegram is P0 notification/activation channel. WhatsApp Business, LinkedIn OIDC and Luma API are optional integrations with hard gates.

## 1. Start here — exactly in this order
1. `autoclaw/RUN_THIS_IN_AUTOCLAW.md` — single copy/paste implementation prompt.
2. `docs/09_GAP_AUDIT_2026-09-07.md` — what was missing in v2 and what changed.
3. `docs/01_PRODUCT_SPEC.md` + `openspec/PRD.md` — product scope and P0.
4. `docs/04_ARCHITECTURE.md` + `implementation/REFERENCE_STACK.md` — target system.
5. `docs/26_GITHUB_REUSE_V3.md` — exact reuse map from ColmoCode / neko_bot.
6. `tests/PRODUCTION_ACCEPTANCE.md` — release definition of done.
7. `operations/RELEASE_RUNBOOK.md` — staging → production → rollback.
8. `contest/SUBMISSION_CHECKLIST.md` — competition evidence and final external rules check.

## 2. P0 outcome
A user can create one profile, choose public fields, receive a stable opaque QR URL, share it outside any event, join an event from a verified registration, state needs/offers, receive explainable recommendations, request an introduction, exchange selected fields only after both sides accept, save a private note/next step, link Telegram, revoke consent, export/delete data. Organizer can import participants, see event-level aggregate state, send only purpose-authorized communications and never see a user's global network/private notes.

## 3. Current recommended implementation
- **Web/API:** Next.js + TypeScript, server-side authorization for every private route.
- **DB:** PostgreSQL (managed Supabase is a practical P0 host; choose an EU region deliberately).
- **Async:** transactional outbox + bounded worker; no external queue required for P0.
- **Auth:** email OTP/magic link or equivalent managed auth; Telegram link is a channel binding, not an identity shortcut.
- **Event import:** generic CSV and Luma CSV first; Luma API/webhooks only when Luma Plus/API key is present.
- **P0 channel:** Telegram Bot API webhook + deep link. WhatsApp Business is P1/optional.
- **Matching:** deterministic `contracts/matching.mjs` rules; LLM may only rewrite human-readable reason, not decide authorization/consent.

Do **not** use Google Sheets/Airtable as the production source of truth for identity, permissions or mutual consent. Do not scrape LinkedIn. Do not treat AutoClaw's own WhatsApp/Telegram control-channel feature as a production multi-user WELCOME messaging integration.

## 4. AutoClaw role
Official AutoClaw material available on 2026-09-07 advertises web product building with runnable frontend preview, browser automation and IM integrations; Cluster Mode describes plan → research → parallelize → audit → deliver. Use those native capabilities for implementation and browser verification. ColmoCode is the **external evidence/review/release contract**, not a claim that its current `agy` maker is AutoClaw.

No undocumented AutoClaw CLI or machine API is assumed in this archive. If the installed version exposes additional safe capabilities, record them in `evidence/IMPLEMENTATION_ENVIRONMENT.md` before use.

## 5. Competition status
A current mirror of the official AutoClaw X account reports a **Sep 1–7** build campaign: eligible entries receive 1,500 credits; top five receive one month of AutoClaw Pro worth $100; the post instructs entrants to tag `@AutoClawAIer` and submit through a Google Form, and explicitly says to read campaign rules. The shortened Form/Rules URLs and exact cutoff timezone were not fully resolved by the research environment. Therefore **submission is blocked until the exact rule document and form are opened manually**. This does not block product implementation.

## 6. What is already verified in the archive
The v2 prototype remains included and reproducible: deterministic matching unit tests, local landing browser checks and evidence. It is not backend/production evidence. V3 adds an archive validator, security/negative tests specification, integration contracts, current-source registry and release checklist.

Run pack checks:
```bash
python3 scripts/validate_pack.py
node --test tests/core.test.mjs
python3 scripts/generate_manifest.py
```
Optional browser regression (requires Playwright/Chromium):
```bash
./scripts/check-preview.sh
```

## 7. Never claim these without evidence
- “auto-enriched from LinkedIn” — OIDC lite profile is not employment history.
- “WhatsApp bot works” — a `wa.me` link or AutoClaw personal IM connection is not WhatsApp Business Platform delivery.
- “contacts were exchanged” — one click/request is not mutual consent.
- “delivered” — provider acceptance is not recipient delivery unless provider evidence says so.
- “GDPR compliant” — engineering controls do not replace controller/legal review.
- “competition submitted/won” — only real submission confirmation/result counts.

## 8. Legacy / provenance
`legacy/` contains the previous v2 ZIP, standalone v2 spec/landing/screenshots. `input/original-spec.md` is the initial source document preserved for traceability. V3 supersedes old market-uniqueness and auto-enrichment claims where they conflict with verified research.

---

# Product specification

Версия 2.0 · 07.09.2026 · статус: спецификация для реализации, не акт готовности backend.

## 1. Решение, ради которого стоит делать
**WELCOME — личный нетворкинг-профиль с постоянным QR и помощником, который превращает знакомство в понятный следующий шаг.** Для организатора — лёгкий слой знакомств поверх существующей регистрации. Для человека — инструмент, который работает и без согласия организатора подключать платформу: показать свой QR можно на любой встрече.

Личный профиль не принадлежит мероприятию. Организатор не получает всю историю участника. Люди сами выбирают публичные контакты, участие в подборе и подписку на новые события. Основная единица ценности — не «ещё одна строка в базе», а полезное знакомство с сохранённым контекстом.

**Гипотеза отличия:** переносимый профиль + цели на конкретное событие + понятная причина рекомендации + согласованный следующий шаг + повторное использование вне этого события. Это комбинация и фокус исполнения, а не доказанная уникальность или технологический барьер.

## 2. Для кого первая версия
Первый сегмент: организаторы повторяющихся профессиональных встреч на 20–200 человек, которые готовы включить ссылку в письмо регистрации и выделить минуту на объяснение сценария. Форматы — камерные B2B-встречи, профессиональные клубы, коворкинги, онлайн-разборы и вебинары с нетворкингом.

Личный сегмент: специалисты и основатели, регулярно знакомящиеся с людьми. Профиль доступен бесплатно как канал распространения. Платящий клиент в гипотезе — организатор повторных событий. Экспонентские lead-scanning команды, выставки на десятки тысяч и полноценная социальная сеть — не первый рынок.

Проверить ценность сначала на собственном использовании и трёх согласованных пилотах, а не строить огромную CRM. Пилотные пороги — ниже; они не являются прогнозом конверсии.

## 3. Объекты и границы продукта
Человек → один аккаунт → один профиль → много членств в событиях → много сохранённых знакомств.

Профиль: display_name, headline/роль, company по желанию, short_bio, языки, offer_tags, need_tags, ссылки и выбранные публичные поля. Email для входа не становится публичным email. Телефон WhatsApp не становится публичным из-за подключения канала бота.

Событие: organizer_id, название, slug, формат offline/online/hybrid, IANA timezone, start/end UTC, место или защищённая online-ссылка, окно доступности нетворкинга, политика входа, лимит участников, текст согласия.

Членство: profile_id, event_id, membership_status, event-specific intent/offer overrides, directory visibility и доступные контакты. Подтверждённый билет — отдельный объект, если когда-либо подключён ticketing. Наличие профиля или нажатие «Я здесь» не доказывает оплату и физическое присутствие.

Знакомство: стороны, контекст/событие (может отсутствовать), статус, две независимые стороны согласия, выбранные поля для раскрытия. Личная заметка видна только автору. Организатор видит агрегаты, не приватную сеть или переписку.

## 4. Обязательные пользовательские сценарии
### S01. Личная карточка без мероприятия
Владелец создаёт профиль, выбирает публичные поля, получает постоянную ссылку `/p/<opaque_slug>` и QR. Другой человек сканирует QR и сразу видит имя, роль, описание и только разрешённые ссылки. Может открыть опубликованный LinkedIn, сайт, WhatsApp или скачать публичную vCard без регистрации в WELCOME.

Создание своей карточки и сохранение заметки — дополнительное предложение после получения пользы. Отказ не блокирует просмотр контакта. Посетителю не обещают, что сканирование автоматически сохранило данные в адресной книге: скачивание vCard ещё может требовать подтверждения телефона.

Публичный QR не является секретом входа; его разрешено фотографировать. Скан не авторизует посетителя владельцем. Изменение выбранных публичных полей не требует перепечатывать QR. Удаление/деактивация профиля закрывает страницу и её API. Уже скачанный другим человеком контакт нельзя гарантированно отозвать.

### S02. Профиль подготовлен ДО мероприятия
Организатор экспортирует законно доступную регистрацию CSV либо подключает подтверждённую интеграцию. Импорт создаёт **event-scoped pending registrations**, не глобальные публичные аккаунты. Сохраняются исходный provider_guest_id, mapping полей и происхождение данных.

Участник получает claim-ссылку через разрешённый регистрационный канал. Не показывать чувствительные поля только по знанию ссылки: перед присвоением импортированной записи требуется подтверждение соответствующего email/аккаунта. До проверки отображать только название события, не чужое досье.

После проверки показать: «Данные из регистрации. Проверьте, что всё верно». Человек подтверждает имя/роль, выбирает «Что ищу» и «Чем могу помочь», отдельно включает видимость для участников. Уже существующий профиль не перезаписывается импортом без выбора владельца. После подтверждения готовится shortlist до трёх кандидатов, если есть подходящие участники.

Нельзя автоматически объединять аккаунты по одинаковому имени, компании, LinkedIn URL или неподтверждённому email. Для conflict merge нужна проверка обеих учётных записей и безопасное восстановление.

### S03. Вход без предрегистрации
Скан `/e/<slug>`. Если есть действующая сессия, предложить «Участвовать как [имя]», не скрывать смену аккаунта. Без сессии — email OTP или Telegram-first с подтверждением идентичности; для первоначального знакомства можно просмотреть только публичную информацию события. Минимум нового профиля: имя и хотя бы один запрос/предложение, остальное прогрессивно.

Публичное событие: пользователь осознанно вступает. Закрытое: pending approval или подтверждённая регистрация; секретный код события может разрешить членство, но не присвоить чужую личность. Пересланная ссылка приглашения не открывает чужой аккаунт.

### S04. Telegram-first
Пользователь нажимает deep link и Start. Бот получает идентификатор Telegram, предлагает подтвердить display name и запрос. Это может создать отдельный аккаунт без email; email нужен только для присвоения прежней регистрации/восстановления через email.

Связывание уже существующего web-аккаунта с Telegram: короткоживущий одноразовый токен, потом подтверждение в исходной web-сессии и Telegram. Украденный или пересланный токен не даёт автоматически присоединить чужой канал. Telegram username изменяем и не является постоянным ключом.

### S05. WhatsApp — три разных сценария
1. **Контакт человека:** разрешённый владельцем `wa.me` открывает личный WhatsApp. Это не подключение WELCOME-бота.
2. **Распространение:** пользователь сам отправляет ссылку на профиль/событие через системное меню Share. Это не фоновая рассылка.
3. **WELCOME Business bot:** отдельный канал через официальный API после настройки бизнес-аккаунта, номера, webhook и шаблонов. Нажать ссылку недостаточно: пользователь должен отправить сообщение. После этого подтверждается привязка и доступный режим сообщений.

В первой продуктовой поставке 1 и 2 обязательны. Пункт 3 — отдельный integration gate: либо доказан live round trip и канал включён, либо он видимо выключен без имитации. Целевой продукт поддерживает WhatsApp, но отсутствие approval не должно ломать браузер и Telegram.

### S06. Подбор полезных знакомств
Участник видит до трёх карточек и короткое объяснение: «Вы ищете X; человек предлагает X. Вы можете помочь с Y». Это не утверждение о проявленном взаимном интересе. Не показывать процент «совместимости» как научную оценку.

«Предложить знакомство» создаёт запрос. Получатель может принять/отклонить/пожаловаться; отказ не раскрывается как причина и не вызывает повторных просьб. Приватные поля раскрываются только после двух действующих согласий с согласованным набором полей. Публичные ссылки и до этого доступны в рамках опубликованной карточки.

Ноль релевантных кандидатов — нормальное состояние: «Пока нет подходящих запросов. Уточните запрос или вернитесь позже». Не добавлять слабый третий матч ради заполнения UI. Уже знакомые и заблокированные пользователи не предлагаются снова.

### S07. Во время и после события
Оффлайн: обозначение «Я на месте» — добровольный self-report, не проверка билета. Онлайн: «Доступен для разговора», не физическое присутствие. Ссылка на Zoom/Meet видна только разрешённым членам события, не на публичной карточке.

После события — личный список «с кем познакомился», контекст и собственная заметка, кнопка «Согласовать следующий шаг». Статусы: contact_saved → intro_requested → mutually_accepted → next_step_proposed → next_step_confirmed. Нажатие на внешний мессенджер не доказывает состоявшийся разговор.

Одно сервисное напоминание о незавершённом согласованном действии допускается только в доступном и разрешённом канале. Новые офферы/следующие события требуют отдельного разрешения. Никаких автоматических сообщений от лица человека знакомым без подтверждения.

### S08. Организатор
Создать событие, выбрать режим доступа, импортировать и проверить CSV, получить ссылку/QR, предпросмотреть путь гостя, открыть агрегаты: регистрации → активированные участники → профили, включившие подбор → взаимные знакомства → самоотчёты о полезности.

Рассылка: сегмент → основание и purpose → предварительный подсчёт допустимых адресатов → preview → тест на собственный канал → явный запуск → job + счётчики pending/sent/delivered/failed/unknown/suppressed. Организатор не может обещать delivered на основании HTTP 200 send API.

Вместо «всем выгрузить всех» — закрытый добровольный каталог события с по-полевой видимостью. Массовый экспорт всех личных телефонов не реализовывать в P0. CSV организатора содержит только разрешённые данные его события, не приватные связи.

## 5. Scope и порядок
### P0 — минимальный полезный production
Личный профиль и QR; публичная ограниченная карточка и vCard; вход; собственная регистрация/CSV импорт; event memberships; Telegram канал; запросы и предложения; объяснимый подбор; двусторонние знакомства; личная заметка/следующий шаг; организаторская панель; отдельная подписка; лимитированная рассылка; отзыв согласий; блок/жалоба; удаление/экспорт аккаунта; мониторинг, backup и rollback; responsive landing RU/EN/ES в финальном продукте.

Поставленный здесь интерактивный landing — RU с русской локальной демонстрацией. Переводы EN/ES входят в очередь реализации, не объявляются уже готовыми.

### P1 — интеграции после подтверждения доступа
WhatsApp Business automation; LinkedIn OIDC; Luma API/webhooks; Wallet pass; email-service adapter; необязательное AI-извлечение offer/need и черновик первого сообщения. Ни одна из этих интеграций не должна быть скрытым mock в production.

### Не делать в этом проходе
Продажу билетов и платежный биллинг SaaS; NFT/NFC hardware; собственный видеозвонок; скрейпинг LinkedIn; авторассылку по адресной книге; сбор чувствительных атрибутов; «все знают всех» глобальный поиск; распознавание лиц; запись разговоров; enterprise SSO; корпоративный CRM-комбайн; произвольные AI tools от имени участника.

## 6. Почему web-first и обычный backend
Браузерный вход — продуктовый контракт. Telegram/WhatsApp являются адаптерами одного доменного ядра. Отключение мессенджера не должно уничтожить аккаунт или контакты. AutoClaw — изготовитель/оператор разработки, не сервер с root-доступом для каждого посетителя.

Выбранная целевая архитектура: Next.js + TypeScript для web/server, managed PostgreSQL/Auth (Supabase) в выбранном EU-регионе, transactional outbox и scheduled worker. Версии зависимостей исполнитель фиксирует после проверки текущего стабильного выпуска и CVE; не копирует произвольный старый lockfile. Пакет лендинга намеренно не требует npm для демонстрации; его UI переносится в целевой web app.

Не создавать второй параллельный backend на Python/Sheets. Не переиспользовать старые CRM, outreach и скрейпинг ради самого переиспользования.

## 7. Нефункциональные требования — целевые, не измеренные здесь
Мобильный UX от 360px; все действия доступны клавиатурой, focus visible, HTML landmarks, тексты ошибок рядом с полем, reduced motion. Lighthouse/axe и ручная проверка Safari/iOS обязательны для релиза.

Лимиты первой версии: 200 активных участников события, 5 одновременных событий, тест 1 000 зарегистрированных профилей; 50 одновременных операций входа/сохранения. Цель p95 обычного API <800ms при прогретом сервисе, публичная карточка LCP <2.5s на согласованном mobile test profile. Это release targets; провал требует оптимизации или снижения объявленного лимита.

Webhook durable accept p95 <2s; обработка сообщений асинхронно. Лимит рассылки определяется реальными ограничениями канала, не произвольным обещанием «мгновенно всем». Доставка не exactly-once; дедупликация внутреннего действия и известные состояния отправки обязательны.

Данные и сроки: UTC хранение + IANA timezone на событии; proposed event networking window до 30 дней после события; неактивированные импорты удалять через 30 дней после события; raw webhook body после минимального диагностического окна удалять; личная карточка сохраняется до удаления аккаунта. Точные retention и правовые основания фиксируются до запуска, не рекламируются как универсальное требование закона.

## 8. Метрики и проверка спроса
North Star: число **подтверждённых обеими сторонами полезных знакомств**, а не сканов. Отдельно хранить mutual consent и самоотчёт «полезно»: не приравнивать принятие интро к выгоде.

Уникальность: анонимный просмотр не становится идентифицированным лидом. Event scan, profile view, account activation, channel opt-in, marketing opt-in и intro accepted — разные события.

Пилотная гипотеза: 3 организатора, каждый 20–100 приглашённых; не смешивать несколько повторов одного человека в «новые пользователи». Целевые решения продолжать: ≥50% пришедших активировали профиль; ≥30% активированных получили хотя бы одно взаимное знакомство; ≥20% ответивших подтвердили полезность; ≥15% активированных повторно использовали личный QR за 30 дней; минимум 2 из 3 организаторов согласны повторить, минимум один оплачивает пилот. Это заранее предложенные пороги, а не доказанный спрос.

При нулевой повторной пользе личного QR не расширять платформу: проверять формулировку ценности и альтернативу Blinq/Fotify. При хорошем личном использовании, но отсутствии готовности платить у организаторов — переключить модель, а не считать регистрации выручкой.

## 9. Оплата и экономика — гипотезы, не рыночный факт
Предложение для теста: личный профиль бесплатно; первый пилот по соглашению; затем €29 за событие до 100 активированных либо €59/мес за повторные события с лимитом 500 активированных/мес. Не публиковать эти цены как действующие, пока нет работоспособного billing/договора и расчёта налогов. WhatsApp template costs отдельно ограничиваются бюджетом, а не обещаются безлимитно.

Сценарий расчёта при тестовой цене €29 и условной переменной себестоимости €4/событие: contribution €25. При условных фиксированных €70/мес технический break-even — ceil(70/25)=3 события/месяц. Это не окупаемость бизнеса: труд, привлечение, налоги, платёжные комиссии, поддержка и конкурсная разработка здесь не включены. При 20 событиях gross revenue €580; после €80 variable и €70 fixed остаётся €430 до перечисленных расходов.

Низкая цена может не поддержать продажи и поддержку. Альтернативный платёжный тест — сервисный запуск события €149 с настройкой и отчётом. Не объявлять выбранную модель подтверждённой без оплат.

## 10. Definition of Done
Два реальных тестовых пользователя на разных устройствах проходят предрегистрацию/вход, получают свои профили, сканируют друг друга, независимо подтверждают обмен, видят только разрешённые поля, выполняют следующий шаг и отзывают согласие. На третьем неподключённом устройстве открывается публичная карточка без аккаунта. Два организатора не видят данные друг друга.

Обязательны unit/integration/RLS/e2e/browser/security tests, реальный Telegram round trip, clean build, secret scan, независимый review, preview, health check, проверенный rollback и handoff с точным SHA. Маркетинговый landing, bot и backend называют production только после этих проверок. Победа в конкурсе не часть Definition of Done и не может быть гарантирована.

---

# Gap audit v3

Date: 2026-09-07. Purpose: identify what could make an autonomous implementation fail, falsely pass, or ship a product that is useful only during one demo.

## A. Critical gaps found
| Gap | Risk | V3 resolution |
|---|---|---|
| AutoClaw execution model in v2 was too defensive/outdated | Could route implementation through `agy` and then claim AutoClaw authorship | Added AutoClaw-native runbook based on current official capabilities; ColmoCode remains external QA/release layer |
| Competition rule source was not verified | Wrong deadline/timezone/eligibility/reuse claim | Current X campaign evidence added; exact Google rule/form still a hard final external gate |
| “Bot in GitHub” was not located | Agent may invent reuse or copy wrong project | Deep audit found reusable primitives in `neko_bot`; exact file/SHA manifest included; no claim that it is the old Welcome bot |
| Existing `neko_bot` consent semantics are unsafe for reuse | Language switch can be interpreted as consent | Consent implementation must be new purpose-scoped affirmative action; old parser forbidden |
| Event provider integration underspecified | Manual import becomes fragile; paid API may block launch | CSV is P0 contract; Luma Plus API/webhook is P1 with explicit field map/dedupe/quarantine |
| AutoClaw IM integration could be confused with WELCOME messaging | Personal/control channel ≠ multi-user product API | Explicit separation: Telegram Bot API / WhatsApp Business Platform are product integrations |
| Competitor differentiation still vulnerable | QR + match + mutual reveal already exists | Positioning moved to reusable identity/profile + cross-event continuity + private next-step memory + organizer boundary |
| Production data governance too broad | Organizer could become owner of user's global network | Controller/scope boundaries, purpose-specific consent, retention/export/delete and aggregate organizer analytics added |
| Async delivery semantics not fully operationalized | Duplicate or phantom sends | Outbox state machine, unknown outcomes, idempotency/reconciliation and retry budget documented |
| Release evidence scattered | Agent may call local demo production | Unified production acceptance + immutable artifact release report + rollback runbook |
| Cost/budget missing | Optional enrich/messaging could silently create spend | Cost guardrails and variable-cost ledger added; no hidden paid resource creation |
| Localization was scope-only | RU prototype might be submitted globally | EN is competition/default surface; RU/ES are required P0 localization tests, no machine-translated legal claims without review |
| Abuse/moderation underdeveloped | QR enumeration, stalking, spam, organizer broadcast abuse | Threat model, rate limits, block/report, anti-enumeration, campaign approval, audit requirements added |

## B. Product gap that matters most
The moat is **not** event matchmaking. Fotify, Grip, Whova, b2match and others already match attendees, exchange contacts or schedule meetings. WELCOME must test whether a person keeps a portable profile/QR and relationship memory across multiple events. The P0 analytics therefore separates:
- profile created;
- QR viewed;
- event joined;
- recommendation shown;
- intro requested;
- both accepted;
- next step saved;
- next step confirmed;
- profile reused at another event / direct scan;
- 30-day return.

North Star remains mutually accepted introductions that later receive a user-reported useful outcome. “Scan count” is a funnel metric, not success.

## C. Implementation blockers that remain intentionally unresolved
1. Actual production domain and legal entity/controller details.
2. Production hosting credentials and region.
3. Telegram bot token and public webhook URL.
4. Email/OTP provider if managed auth is not sufficient.
5. Exact AutoClaw competition rules/form URL and cutoff timezone.
6. Optional Luma Plus API key, WhatsApp Business account/number, LinkedIn app credentials.
7. Actual privacy notice/controller/DPA review for launch jurisdiction.

An autonomous agent must mark these `BLOCKED_EXTERNAL`, disable dependent features, and continue all unaffected work. It must never fill them with guessed values.

## D. Quality failures that must fail closed
- PASS review without exact staged diff and acceptance criteria.
- contradictory review containing both PASS and FAIL.
- browser screenshot with console/network errors hidden.
- seeded demo user leaking into production analytics.
- public endpoint returning private contacts in HTML/hydration JSON.
- organizer accessing a profile's private notes/global connections.
- expired/forwarded claim link binding the wrong account.
- duplicate webhook creating duplicate registration/introduction/send.
- consent withdrawal followed by a queued marketing send.
- optional integration silently replaced by a mock in production.

---

# Current research

Freeze: 2026-09-07. Vendor feature statements are vendor claims, not independent performance validation.

## 1. AutoClaw
**Official:** https://autoclaw.z.ai/  
The current product page describes AutoClaw as an AI agent for work and lists web product building, browser automation and IM workflows among core capabilities. The web-product section says a page/dashboard/mini app/internal tool can be turned into runnable frontend code with browser preview.

**Official Cluster Mode:** https://autoclaw.z.ai/blog/product/autoclaw-cluster-mode-professional-team/  
Published 2026-05-29. Describes a strict SOP: plan, research, parallelize, audit, deliver. V3 maps implementation roles onto this rather than inventing a custom AutoClaw CLI.

**Official Auto Design:** https://autoclaw.z.ai/blog/product/autoclaw-v1-9-0-glm-5-2-auto-design/  
Published 2026-06-24. Accepts long PRDs and produces complete UI workflows; design can be refined and imported into Figma. Use this for UI generation/review, not as proof the backend exists.

**Current model blog:** https://autoclaw.z.ai/blog/  
On 2026-09-06 AutoClaw published GLM-5.3-Flash material. The implementation pack does not pin a model; the owner chooses an explicit available model/profile at run time.

## 2. AutoClaw build campaign
Current mirrors of the official X account `@AutoClawAIer` show the post text: Sep 1–7, share a website/app/prototype/other digital project made with AutoClaw; eligible entries get 1,500 credits; top 5 get one month of AutoClaw Pro worth $100; tag the account and submit the post using a Google Form; read campaign rules first.

Research limitation: shortened/truncated Google Form and rule document URLs were not fully resolved. Do not infer exact cutoff timezone, eligibility or prior-code rules. `contest/SUBMISSION_CHECKLIST.md` requires a manual final check.

## 3. Competitor reality
| Product | Verified overlap | Strategic implication |
|---|---|---|
| Fotify Match & Connect | Browser/no app, Business mode, recommended connections, mutual contact reveal; official page currently says $19.99 add-on/event | QR + browser + mutual reveal is commodity, not WELCOME moat |
| Grip | AI matchmaking/event app; explicit/implicit preferences and mutual-interest framing | “AI matching” alone is not differentiation |
| Whova | Attendee profiles/list, recommended connections, messaging, contact exchange/business card tools, meeting/networking | Large suite already covers event networking lifecycle |
| b2match | registration, rich profiles, AI matchmaking, meeting scheduler, messaging, analytics | B2B meeting orchestration already established |
| Popl | QR/digital cards, badge/business-card/LinkedIn QR scanning, enrichment, CRM sync, follow-up | Reusable cards and event lead capture already exist |
| Blinq | reusable digital business cards and QR; free/premium personal plans | Persistent card alone is insufficient |

The product thesis must be tested as an **integrated portable relationship layer**: same profile/QR across events, explainable need↔offer matching, field-level mutual reveal, private owner notes/next steps, event organizer separation and re-use metrics.

## 4. Luma
- API help: https://help.lu.ma/p/luma-api — current help says API access requires active Luma Plus for the calendar and uses a calendar-scoped API key.
- Registration questions: https://help.lu.ma/p/collect-registration-questions — Luma can collect company/social profile/etc. and export guest answers to CSV.
- P0: CSV import works without a production API dependency.
- P1: API + webhooks only with verified key and webhook contract.

## 5. LinkedIn
Official Microsoft/LinkedIn OIDC guide:  
https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2

Scopes `openid`, `profile`, `email` cover authentication and lite profile (id/name/profile picture, email when permitted). This does **not** support a promise of automatically importing job/company/employment history. WELCOME asks the user to confirm professional fields; no scraping/cookies.

## 6. Telegram
- Bot features/deep linking: https://core.telegram.org/bots/features
- Deep links: https://core.telegram.org/api/links
- Bot API: https://core.telegram.org/bots/api

Use `t.me/<bot>?start=<parameter>` with a short opaque one-time purpose-bound token. User activation is required. The start parameter is not consent and not an authorization decision.

## 7. WhatsApp Business
- Messaging policy: https://business.whatsapp.com/policy/
- Platform pricing: https://business.whatsapp.com/products/platform-pricing

Business-initiated conversations/messages must follow approved template rules. Free-form replies are constrained by the customer-service window. Pricing varies by category/market; do not hardcode “free”. WELCOME P0 can expose a user-controlled WhatsApp contact link, but automated WELCOME messaging is not production-ready until Business Platform credentials/webhooks/template policy are verified.

## 8. GDPR engineering baseline
- European Commission — individual information/consent: https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en
- European Commission — GDPR principles: https://commission.europa.eu/law/law-topic/data-protection/information-business-and-organisations/principles-gdpr_en
- EDPB basic principles: https://www.edpb.europa.eu/topics/key-gdpr-concepts/basic-principles_en

When relying on consent, it must be freely given, specific, informed, unambiguous and withdrawable; purposes must be separated. Engineering baseline: purpose limitation, data minimization, storage limitation, integrity/confidentiality, accountability. This is not a substitute for launch legal review.

---

# Architecture

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

---

# Landing/UI specification

## Концепция
Не «AI networking revolution», а понятная демонстрация результата. Светлый фон, тёмная типографика, коралловый акцент, крупный заголовок и собранная HTML-карточка вместо стоковых фото. Рабочий бренд WELCOME. Без выдуманных логотипов клиентов, отзывов, счётчиков пользователей и обещаний роста выручки.

Главный заголовок: **«Один QR. Новые знакомства. Связи надолго.»**
Подзаголовок: «Ваш профиль — с вами на каждой встрече. Делитесь контактами, находите полезных людей и сохраняйте следующий шаг. В зале, в чате и после события».

Два пути: «Попробовать личный QR» и «Посмотреть сценарий события». В поставленном preview они ведут в честно обозначенное локальное демо. В production: первая — `/start?intent=personal`, вторая — `/organizer/new`. Не показывать «Ваш аккаунт создан» без backend.

## Структура
1. Header: знак W, название, навигация «Для себя», «Для событий», «Как работает», демо CTA.
2. Hero: обещание + живая карточка; подпись «В браузере. Без отдельного приложения. Вы выбираете, чем делиться».
3. Полоса смыслов: один постоянный профиль / до, во время и после / контакты под вашим контролем. Не метрики клиентов.
4. «Сканируют. Понимают, кто вы. Сохраняют контакт»: personal use case, публичные и закрытые поля, нет bot gate.
5. «Не начинайте знакомство с заполнения анкеты»: три стадии события; предрегистрация, подсказки, follow-up.
6. Интерактивный сценарий: переключатель «Личный профиль / Событие / Организатор», локальный mock dataset с постоянным баннером DEMO.
7. Privacy: выбор полей; QR не выдаёт телефон; участие не равно подписке; один человек может отказаться.
8. FAQ: нужен ли Telegram, как работает WhatsApp, можно ли без организатора, LinkedIn import, онлайн, слабый интернет.
9. Closing CTA. Footer: статус demo, privacy explanation, reset. Нет юридического обещания «100% GDPR compliant».

## Состояния и реальные действия preview
Личный профиль: открыть карточку, изменить видимость email, скачать публичную vCard, скачать QR, скопировать local demo link. Событие: показать данные из условной регистрации, подтвердить участие и directory consent, получить кандидата, отправить запрос, отдельно симулировать ответ второго пользователя, увидеть следующий шаг. Организатор: живые счётчики только текущего demo state, явное описание отсутствующего live backend.

Все seeded люди вымышлены. Значения `.example`/`example.org` не ведут к реальным пользователям. Никакая кнопка не отправляет им сообщение. Сохранение и «матч» существуют только внутри демонстрационной сессии, с reset.

## Production screen map
`/` landing; `/start` вход/создание; `/p/:slug` публичная карточка; `/me` личный кабинет; `/me/privacy`; `/me/contacts`; `/e/:slug` вход/информация события; `/e/:slug/join`; `/e/:slug/people`; `/e/:slug/matches`; `/intro/:id`; `/organizer`; `/organizer/events/:id`; `/organizer/events/:id/import`; `/organizer/events/:id/campaigns`; `/settings/channels`; `/settings/data`; `/legal/privacy` и `/legal/terms` после заполнения реальными реквизитами.

Каждый защищённый экран требует server-side authorization, не только скрытую кнопку. Public preview не включает приватные поля в HTML, hydration JSON или API response.

## Качество UI
360/390/768/1440 px без горизонтального скролла; кнопки минимум 44px; контраст WCAG AA проверяется инструментом; показ errors/empty/loading/expired/blocked/offline; modals focus trap + Escape; реальные labels; текст на кнопке не только иконка; preference reduced motion. Mobile Safari, Android Chrome и встроенные браузеры мессенджеров проверяются отдельно.

## Copy guardrails
Запрещено: «Мы уже знаем, кто ты», «0 полей для всех», «LinkedIn подтянем полностью», «Взаимный интерес» до ответа обеих сторон, «сообщение доставлено» без подтверждения, «все гости подписаны», «победа гарантирована», «почти бесплатно», «работает без интернета» для незагруженной web-страницы.

Допустимо: «Данные из регистрации — проверьте их», «Открыть WhatsApp», «Подключить уведомления», «Выбрать публичные поля», «Приглашение принято обеими сторонами», «Пока нет подходящих запросов».

---

# AutoClaw-native execution


## Why v3 changes the execution model
The previous pack correctly refused to pretend that the current ColmoCode `agy` maker was AutoClaw, but it underused current AutoClaw capabilities. Official current material explicitly presents web product building, browser automation, long-PRD Auto Design and Cluster Mode auditing. Use AutoClaw as the primary implementer; use repository-local tests and independent reviews as external evidence gates.

## Role map for Cluster Mode
- **Lead / Architect:** reads PRD, architecture, acceptance matrix; creates implementation plan and ADRs. No code until plan and data boundaries are explicit.
- **Backend implementer:** schema, auth, RLS/application authorization, imports, matching, introductions, outbox.
- **Frontend implementer:** public card, account/profile, event flows, organizer dashboard, i18n/accessibility.
- **Integration implementer:** Telegram P0, Luma CSV; optional Luma API/LinkedIn/WhatsApp only when preflight passes.
- **QA:** unit/integration/e2e/browser/negative fixtures; never edits acceptance criteria to make code pass.
- **Security/privacy reviewer:** tenancy, tokens, webhooks, consent, logs, exports, QR abuse, secret scan.
- **Release auditor:** immutable SHA/artifact, staging evidence, rollback rehearsal, production promotion.

If AutoClaw chooses fewer/more roles, these responsibilities still must be covered in evidence.

## Hard execution rules
1. One Git repository / clean worktree. Existing user repos are read-only reuse sources unless owner explicitly chose a target.
2. Build tests/gates before feature implementation. Gate definitions, acceptance matrix and release policy are protected from implementation agents.
3. No invented AutoClaw CLI/API. Use capabilities actually exposed by installed AutoClaw; document them in `evidence/IMPLEMENTATION_ENVIRONMENT.md`.
4. No automatic model fallback. If a model/quota is unavailable, record `BLOCKED_PROVIDER` or require owner-selected alternative.
5. Maximum three identical failure fingerprints before a repair diagnosis; no infinite retry.
6. Optional integration absent => visibly disabled + passing disabled-state tests, not mock “success”.
7. Final reviewer receives exact diff/commit SHA + acceptance criteria + test logs. Review parser rejects empty/contradictory result.
8. Production permission is separate from implementation permission. Never deploy every task individually.
9. Staging comes first. Real QR, real Telegram round trip, revoke/delete and two-tenant negative tests must run against staging.
10. Production promotion uses the same reviewed immutable artifact. Health failure triggers rollback and final status remains FAIL.

## Evidence directory to create during implementation
```text
evidence/runtime/
  environment.md
  plan.md
  test-unit.log
  test-integration.log
  test-e2e.log
  browser/
  security.log
  rls-negative.log
  telegram-roundtrip.json
  luma-import.json
  build.json
  review.md
  staging-release.json
  rollback-rehearsal.json
  production-release.json   # only if authorized
  RELEASE_REPORT.md
```
Never put secret values, raw access tokens, private message bodies or unredacted exports in evidence.

---

# Luma/event integration


## Principle
WELCOME must not require an event platform to be useful. The permanent profile/QR works independently. Event registration is an adapter.

## P0 — generic/Luma CSV
Organizer uploads a CSV to one event. Server parses into a staging table first; nothing becomes an active membership until validation/claim rules succeed.

Minimum canonical fields:
- `external_guest_id` (optional; preferred when present)
- `email` (identity hint, stored encrypted; normalized hash for lookup)
- `name`
- `approval_status`
- `checked_in_at` or boolean attendance signal (optional)
- `company`, `linkedin_url`, `website` and custom answers as *unverified imported attributes*

Rules:
1. Never execute spreadsheet formulas from imported cells; trim size and neutralize formula prefixes on exports.
2. Validate email format but never reveal whether an email is registered to anonymous callers.
3. Deduplicate by `(event, external_guest_id)` when present; otherwise `(event, normalized email hash)` with explicit collision handling.
4. Re-import is idempotent: update allowed imported fields/revision, no duplicate membership/intro.
5. Imported professional fields are not “verified LinkedIn data”. User can confirm/edit on claim.
6. Unknown approval/status value -> quarantine, not “approved”.
7. CSV raw file gets short retention; parsed canonical rows are audited.

## P1 — Luma API + webhook
Official Luma help currently says API access needs active Luma Plus and a calendar-scoped API key. Implement only when present.

Adapter responsibilities:
- backfill events/guests using API;
- receive `guest.registered`/guest updates per current docs;
- authenticate/verify webhook exactly as current Luma docs specify (do not invent signature scheme);
- durable inbox with unique provider event id;
- map to the same canonical registration service as CSV;
- replay-safe and idempotent;
- quarantine unknown schema/status;
- API failure must not corrupt existing registrations.

## Claim flow
Import does not create a logged-in account. User opens a personal event claim link → authenticates with the allowed method → server proves linkage to one registration → confirms imported fields → explicitly chooses event-directory visibility/notification purposes. Forwarding a link alone cannot claim a registration.

See `contracts/luma-field-map.example.json` and `templates/luma-import-example.csv`.

---

# Privacy/GDPR engineering

This is an implementation specification, not legal advice or a final privacy notice.

## Data ownership boundary
- **Personal profile:** user-controlled, reusable across events. Organizer never owns the user's global profile, private notes or cross-event network.
- **Event membership:** organizer-scoped event data, limited to event purpose and role authorization.
- **Introduction:** private between two participants. Organizer may receive aggregate counts, not the content of private notes or automatically all contact fields.
- **Marketing:** separate purpose. Joining an event / scanning a QR / starting Telegram does not silently opt a person into organizer or product marketing.

## Consent purposes (when consent is the chosen legal basis)
Use independent records, not one global boolean:
- `PUBLIC_CARD_FIELD`
- `EVENT_DIRECTORY`
- `INTRO_FIELD_REVEAL`
- `SERVICE_CHANNEL_TELEGRAM`
- `ORGANIZER_MARKETING`
- `PRODUCT_MARKETING`

Each record stores scope, field set, policy/version, affirmative action, timestamp and withdrawal. A language choice, page view, link click, imported registration or `/start` parameter is never consent.

## Data minimization
Public card API returns only enabled public fields. Organizer dashboard uses event projections. Matching reads normalized needs/offers and eligibility flags, not private notes, email body, phone, nationality, gender, photo similarity or sensitive categories.

## Retention targets for pilot (must be confirmed before launch)
- raw import file: delete after successful canonical import + short diagnostic window;
- unclaimed registrations: proposed deletion 30 days after event;
- raw webhook bodies: minimal diagnostic TTL, then delete/redact;
- event networking window: proposed 30 days after event unless user keeps a connection explicitly;
- personal profile: until user deletion/inactivity policy;
- audit events: defined retention proportional to security/accountability purpose, without message bodies.

## User rights/product controls
`/settings/data` supports export and deletion request/status. User can revoke public fields, event-directory visibility, channel/marketing consent and introduction field reveal. Product explains consequences without dark patterns. Cache purge is part of revocation.

## Logging
Never log raw OTPs, auth headers, API keys, WhatsApp/Telegram tokens, private contact values, full imported CSV rows or private note text. Error telemetry uses IDs/correlation IDs and redacted metadata.

## Launch gate
Before public launch, fill real controller identity/contact, purposes/legal bases, processors, transfer details, retention, rights/contact route, cookie/analytics details and applicable electronic-marketing rules for launch countries. Do not advertise “100% GDPR compliant”.

---

# Channels and identity


## Telegram — P0
Use Telegram Bot API webhook over HTTPS. Configure webhook secret token and validate the header. Persist/dedupe `update_id` or provider event id.

Binding flow:
1. Authenticated WELCOME user asks to connect Telegram.
2. Server creates random purpose-bound one-time challenge (hash stored, TTL ~10 min).
3. Browser opens `https://t.me/<bot>?start=<opaque>`.
4. User presses Start / sends `/start`; bot receives the token.
5. Server atomically consumes challenge and binds Telegram user id to the same account.

The deep-link token is not an account bearer token, not contact-sharing consent and not reusable. Never put email/profile UUID/private data in the `start` value.

Commands P0: `/start`, `/profile`, `/qr`, `/events`, `/need`, `/matches`, `/connections`, `/privacy`, `/stop`, `/delete`, `/help`. Every command checks account binding and current purpose/visibility.

## WhatsApp — optional P1
Two distinct features:
1. **User-provided public WhatsApp contact link** — just a link/field on the personal card, controlled by user visibility.
2. **WELCOME automated messaging** — WhatsApp Business Platform integration with business account/number, templates, webhooks, opt-in and current pricing/policy.

AutoClaw being controllable through a user's WhatsApp does not prove #2. A `wa.me` link does not prove #2. No competition screenshot should imply otherwise.

## LinkedIn — optional P1
Official OIDC scopes can authenticate and retrieve lite profile data. WELCOME may use this as an optional sign-in/import helper, but:
- do not claim employment/company/history enrichment;
- do not scrape LinkedIn or import browser cookies;
- display what was imported and let the user confirm/edit professional fields;
- LinkedIn profile URL may be user-supplied/validated as a link without server-side fetch.

## Channel abstraction
Use a small interface inspired by `neko_bot/src/channels/adapter.js`: parse inbound → normalized event; send message → provider result. Do not copy Instagram-specific fields or assumptions. Provider adapters must return `sent | delivered | failed | unknown | suppressed` only when evidence supports the state.

---

# Threat model


## Assets
Identity bindings, private contact fields, event memberships, introduction decisions, private notes, organizer campaign authority, webhook secrets, auth tokens and release credentials.

## Top abuse/failure cases
| Threat | Required mitigation/test |
|---|---|
| QR/profile enumeration | opaque random slug ≥128-bit entropy; rate limit; no sequential IDs; 404/403 indistinguishable where appropriate |
| Forwarded event claim link | claim token only selects challenge; auth/registration proof required; one-time TTL; scanners cannot consume GET |
| IDOR / cross-tenant | server authorization + RLS/app checks; direct API negative suite with two organizers/two users |
| Public page leaking private fields | public projection DTO; no private fields in HTML/RSC/hydration/cache; snapshot test |
| Webhook spoof/replay | provider verification, durable inbox unique id, timestamp/replay rules where provider supports |
| Double-click/duplicate webhook | DB constraints/idempotency keys; same resource id returned, no duplicate send |
| Consent race | versioned consent checked again at send/reveal time; withdrawal cancels queued work |
| Organizer spam | purpose-specific eligible audience, preview/test send, approval revision, rate cap, unsubscribe suppression, audit |
| Stalking/harassment | block/report; blocked pair not recommended/revealed; rate limit intro requests |
| CSV/XSS/formula injection | strict parser, escaped rendering, no raw HTML, formula neutralization on export |
| SSRF through avatar/profile URL | do not server-fetch arbitrary URLs P0; upload files with MIME/size validation |
| Prompt injection | LLM never gets tools/DB credentials/authorization decisions; structured allowlisted fields only |
| Token/secret leakage | env/secret manager, secret scan, redact logs, no browser profile/cookies committed |
| Cache after revoke/delete | purge/revisioned cache keys; test old public URL response after revoke/delete |
| Unknown provider result | do not blind resend; reconcile or mark unknown; bounded operator review |
| Admin takeover | organizer owner MFA where supported, least privilege, session expiry, audit privileged actions |

## Security release tests
See `tests/SECURITY_TESTS.md`. High/critical unresolved findings block staging promotion. Medium findings require explicit owner risk acceptance with issue link; no hidden waiver inside prompt.

---

# Observability/SLO


## Correlation model
Every HTTP request gets `request_id`; every inbox webhook gets `provider_event_id`; every business mutation gets `operation_id`; every outbox delivery has `job_id/attempt_id`. Logs carry IDs, never raw private payloads.

## Product funnel metrics
`profile_created`, `profile_public_viewed`, `event_joined`, `intent_saved`, `recommendations_viewed`, `intro_requested`, `intro_accepted_a`, `intro_mutual`, `next_step_saved`, `next_step_confirmed`, `profile_reused_cross_event`, `profile_direct_scan`, `marketing_opt_in/out`, `delete_completed`.

No event view creates a hidden “lead”. Demo tenants are excluded from business metrics.

## P0 reliability targets (targets, not measured guarantees)
- public card availability: 99.5% monthly pilot target;
- p95 ordinary authenticated API: <800ms on agreed pilot load;
- public card LCP: <2.5s on agreed mobile profile;
- background queue oldest-ready age alert: >5 min;
- Telegram send failure alert: rolling failure >5% after excluding user blocks/suppressed;
- duplicate external event processing: zero by uniqueness constraint;
- RPO target ≤24h, RTO target ≤4h until a stricter business requirement exists.

## Health checks
Homepage 200 is insufficient. Staging/production health should cover app build/version, DB read, safe DB write/rollback probe, migration version, queue/worker heartbeat, provider adapter status (without sending), and recent error budget.

## Alerts
P0 operator channel: email/Telegram to the product owner for DB down, auth down, queue stalled, error spike, webhook verification failures, repeated unknown sends, backup failure and security alert. Alert messages contain IDs + dashboard link, not customer data.

---

# Pilot experiment


## The risky hypothesis
People will keep and reuse a WELCOME profile/QR beyond the first event because it combines a portable identity card, event context, explainable introductions and remembered next steps.

## Pilot design
Run 2–3 small events with 20–80 participants and one direct/non-event networking use case. Do not judge product only by registrations.

### Funnel
1. Invited/imported
2. Claimed profile
3. Completed needs/offers
4. Public QR opened
5. Viewed recommendation
6. Requested intro
7. Mutual acceptance
8. Saved next step
9. Confirmed useful outcome
10. Reused profile at another event/direct scan within 30 days

### Primary success measures
- claim/activation rate;
- % activated users who view recommendations;
- recommendation → intro request;
- intro request → mutual accept;
- mutual accept → next step saved;
- mutual accept → user-reported useful outcome;
- 30-day reusable-profile rate;
- organizer repeat intent and actual second event.

Set numeric thresholds **before** each pilot based on event context, not after seeing results. Archive does not invent traction.

## Qualitative interview prompts
- What made you scan or ignore the QR?
- Would you keep this profile if no organizer asked you to?
- Was the match reason believable and useful?
- What information would you refuse to share by default?
- Did the suggested next step reduce friction or feel intrusive?
- Would you use the same QR at a different community/event?
- Organizer: which aggregate metric actually proves event value to you?

## Kill/iterate conditions
If users only activate because organizer forces them and cross-event/direct reuse is near zero, do not scale as a standalone identity network; reposition as event networking infrastructure or narrow to a specific recurring community.

---

# Cost model


## Principle
The archive contains no guaranteed unit economics. Provider rates change. The implementation must record actual variable costs per event/user and never silently create a paid resource.

## Cost buckets
- web hosting / bandwidth;
- managed Postgres/Auth;
- worker/scheduled compute;
- email OTP/messages if applicable;
- Telegram infrastructure (bot API itself may not be the cost driver; hosting is);
- WhatsApp Business delivered messages/templates by market/category when enabled;
- Luma Plus if API integration is chosen;
- optional LinkedIn app/integration work;
- observability/storage/backups;
- AI tokens only for optional reason/copy generation, not authorization/matching core.

## Budget controls for autonomous build
`autoclaw/preflight-v3.json` has `max_external_spend_eur` and per-provider allow flags. If a new paid service is needed, agent records `BLOCKED_BUDGET` and proposes the free/manual fallback. It may not create a paid plan by clicking through checkout unless explicitly authorized.

## Event unit-cost ledger
For each pilot record: active profiles, public views, messages by channel/category, storage/egress, worker minutes, AI calls/tokens, support time, provider subscription allocation. Report gross contribution only with explicit included/excluded items.

---

# Positioning copy


## Category
**Your networking profile that travels with you. Events make it smarter — they do not own it.**

## Hero (EN — competition default)
**One QR. Every event. The right follow-up.**  
Create a profile once, carry it to any meetup, and share only what you choose. WELCOME adds event context, explains who may be worth meeting, and remembers the next step after you leave.

CTA 1: `Create my networking profile`  
CTA 2: `See the event flow`

Microcopy: `No app required. Your contact fields stay under your control.`

## RU
**Один QR. Любые встречи. Нужный следующий шаг.**  
Создай профиль один раз, используй на любых мероприятиях и открывай только те контакты, которые выбрал сам. WELCOME добавляет контекст события, объясняет полезные знакомства и помогает не потерять договорённость после встречи.

## ES
**Un QR. Todos tus eventos. El siguiente paso claro.**  
Crea tu perfil una vez, úsalo en cualquier encuentro y comparte solo lo que tú elijas. WELCOME añade contexto del evento, explica conexiones relevantes y guarda el próximo paso después de conoceros.

## Organizer pitch
“Turn registrations into useful introductions without taking ownership of people's personal networks.” Organizer imports guests, adds event context and sees aggregate networking outcomes. Participant keeps the profile and private connection memory.

## Claims to avoid
“AI finds perfect matches”; “zero forms automatically from LinkedIn”; “GDPR guaranteed”; “free WhatsApp automation”; “only product that does post-event networking”; “we know who you are from the QR”.

---

# Deployment options


## Recommended P0
**Vercel web/API + managed PostgreSQL/Auth (Supabase) + one scheduled outbox processor** is a practical low-ops path if the selected plans support required cron/runtime and an EU DB region is deliberately chosen. If scheduled execution limits become a problem, run the worker as a separate small Node service (e.g. Railway) against the same DB.

The archive does not create these resources or assume a specific plan.

## Why not Sheets/Airtable core
Mutual consent, single-use challenges, idempotent webhook handling, cross-tenant authorization and concurrent introductions require transactional constraints. CSV remains an interchange format, not the authorization database.

## Immutable release contract
Build artifact records commit SHA, dependency lock digest, migration version and frontend/worker version. Staging uses the exact artifact intended for production. Production deployment does not rebuild from a different dependency state.

## Environments
- local: mocks allowed, obvious `DEMO` badge;
- staging: separate DB/bot IDs, real Telegram, synthetic users only;
- production: no seeded demo accounts in normal directory; provider mocks compile-time/runtime disabled; separate secrets.

## Deployment adapter must provide
`build`, `migrate_dry_run`, `deploy_staging`, `smoke_staging`, `rollback_rehearsal`, `deploy_production`, `health_production`, `rollback_production`, and a way to show exact deployed SHA.

---

# Data model notes

The canonical concepts are in `docs/04_ARCHITECTURE.md`; `implementation/schema-contract.sql` is a starter DDL, not a complete Supabase migration. RLS policies depend on the chosen Auth claim shape and must be implemented/tested rather than copied blindly.

## Critical invariants
- one account → one durable personal profile;
- profile public slug is random/opaque, not email/name/sequence;
- event membership links profile to many events;
- organizer roles are independent from participant profile;
- registration import is separate from authenticated account;
- one introduction pair is canonical and idempotent in a context;
- each participant gives independent intro-field consent;
- private notes have one owner and never appear in organizer projection;
- channel binding does not make phone/Telegram username public;
- campaign audience is re-evaluated at send time against consent/block/status;
- webhook inbox/outbox have unique dedupe keys.

## Sensitive values
Encrypt private contact values at rest at application/KMS layer or provider-supported encryption; hashes used for lookup must be keyed or otherwise designed to resist simple enumeration. Never expose service role/database master key to browser code.

---

# API surface

Exact request/response schemas can evolve, but authorization/semantics may not.

## Public
- `GET /api/public/profiles/:slug` — public projection only; cache revision aware.
- `GET /api/public/events/:slug` — minimal public event metadata, no participant directory.

## Authenticated user
- `GET/PATCH /api/me/profile`
- `GET/PATCH /api/me/public-fields`
- `POST /api/me/qr/rotate` — optional emergency slug rotation, invalidates old slug.
- `GET /api/me/events`
- `POST /api/events/:id/claim/start`
- `POST /api/events/:id/claim/complete`
- `PATCH /api/events/:id/membership`
- `GET /api/events/:id/recommendations`
- `POST /api/introductions`
- `POST /api/introductions/:id/decision`
- `PATCH /api/introductions/:id/field-consent`
- `GET/PATCH /api/connections/:profileId/note`
- `POST /api/channels/telegram/link/start`
- `POST /api/channels/telegram/unlink`
- `POST /api/blocks`
- `POST /api/reports`
- `POST /api/me/export`
- `DELETE /api/me`

## Organizer
- `POST /api/organizer/events`
- `POST /api/organizer/events/:id/import/preview`
- `POST /api/organizer/events/:id/import/commit`
- `GET /api/organizer/events/:id/participants` — event projection only.
- `GET /api/organizer/events/:id/analytics` — aggregate networking funnel.
- `POST /api/organizer/events/:id/campaigns`
- `POST /api/organizer/campaigns/:id/approve`
- `POST /api/organizer/campaigns/:id/test-send`
- `POST /api/organizer/campaigns/:id/launch`

## Webhooks
- `POST /api/webhooks/telegram`
- `POST /api/webhooks/luma` (optional)
- `POST /api/webhooks/whatsapp` (optional)

Every private endpoint tests object-level authorization server-side. IDs in bodies are never trusted as actor identity. Mutations use idempotency keys where double submit/provider retry is plausible.

---

# Test plan


## Layers
1. Unit: matching, canonical pair, token helpers, purpose/field policy, CSV parser, URL validation, PII redaction.
2. DB/integration: migrations, constraints, idempotency, outbox leasing, withdrawal race, deletion cascade/soft-delete policy.
3. Authorization/RLS: two users + two organizers + anonymous; direct API/SQL claim tests.
4. Provider contract: Telegram webhook/deep link; Luma CSV; optional live adapters.
5. E2E: browser flows from clean account through mutual introduction and revoke/delete.
6. Security: threat-model cases, secret scan, dependency audit, XSS/CSV formula/CSRF/IDOR/rate limits.
7. Release: staging public URL, actual QR decode/open, real Telegram round trip, worker, backup restore/rollback rehearsal.

## Golden scenario
Alice creates profile → enables LinkedIn URL public but email private → Bob scans → sees only public fields → both join same event → complementary needs/offers → Alice gets Bob with fact-based reason → requests intro → Bob accepts → each separately selects fields → mutual reveal → Alice saves private note/next step → organizer sees +1 mutual intro aggregate, not note/contact → Alice revokes email field → subsequent public/reveal response no longer includes it.

## Required negative scenario
Carol from Organizer A attempts direct GET/PATCH on Organizer B event/profile/intro IDs and must receive 403/404 without leaking existence. Repeat with service-style endpoint and server action, not UI only.

## Review test
Inject a controlled defect into a disposable branch (e.g. return private email in public DTO). Gates/reviewer must FAIL. Remove defect; only then can review system be considered effective.

---

# GitHub reuse v3

Research via connected GitHub on 2026-09-07. File SHAs are blob hashes, not commit SHAs. Implementation agent must record current source repo HEAD before adapting anything.

## ColmoCode — reuse the delivery method, not pretend its maker is AutoClaw
Repository: `nberezniker/colmocode`
- `README.md` blob `0dfd9d8f9b00de00aed95cd0f49a569601d88fc4` — OpenSpec/framework-loop/evidence-first workflow.
- `docs/FRAMEWORK-LOOP.md` blob `f96117e360aca63b9d70f60e6b699b0b5621f787` — real gates, READY pending→active, review/handoff.
- `framework-loop/README.md` blob `0add9d1c7594fcfb56bb4f20ec17b8ea7b3e2c85`.
- `framework-loop/install.sh` blob `c3e91609d9ca343c9bd85298157f1251e56d75e6`.
- `framework-loop/assets/loop.sh` blob `4620fd1989e12c92161fa729b501ae0f3d2ba56c` — current maker invokes `agy`; final-review context must be strengthened to exact diff/evidence and contradictory verdicts must fail.

**Reuse:** OpenSpec queue, protected gates, explicit model choice, independent review, evidence, release permission, preview/health/rollback pattern.  
**Adapt:** AutoClaw execution adapter/managed run.  
**Do not claim:** that running current `plan-run` means AutoClaw built the product.

## neko_bot — strong primitive source, domain logic forbidden
Repository: `nberezniker/neko_bot`; package uses Node ≥20, Express/Postgres, Vitest and Playwright.

### Copy/adapt patterns
| Path | Blob SHA | Use in WELCOME | Caveat |
|---|---|---|---|
| `src/channels/adapter.js` | `3cdab4a4ff8f2950dfae64477a914203828093b2` | tiny provider adapter abstraction + mock pattern | remove Instagram/story/comment concepts; return richer delivery states |
| `src/pii/redactor.js` | `363ae39687f526eb8e5468620dcffd5d92db42dc` | PII-redaction test ideas before optional LLM calls | regex is not full DLP; do not rely on it as sole security control |
| `src/pipeline/scheduler.js` | `59b3d91c01fbb0e1432f5196102f09b9ac065bd9` | scheduled-message → outbox pattern | salon timings/marketing logic replaced; timezone and consent recheck required |
| `src/pipeline/*` + tests | see source tree | durable dispatch/worker/E2E testing ideas | reimplement around WELCOME domain + provider idempotency |
| `src/db/migrate.js`, `src/db/repo.js`, migrations/tests | see source tree | migration/repository discipline, SQL tests | schema is salon-specific, never copy tables wholesale |
| `scripts/run-e2e-scenarios.js`, `run-playwright-simulation.js` | see source tree | scenario-harness style | replace real/salon fixtures with synthetic WELCOME fixtures |
| `src/campaigns/engine.js` | `34b8135a9bb7b5be30fad679f0b7307ee83dd399` | rate/cooldown/audience prefilter idea | business logic is salon marketing; WELCOME requires purpose-scoped eligibility at send time |

### Specifically DO NOT reuse consent semantics
`src/consent/service.js` blob `2aeb12437c0ac761922ef21f2ece2b40bc814fbb` includes logic where an explicit language change is treated as consent. WELCOME **must not** inherit this. Build purpose-scoped explicit affirmative controls instead. Keep only the idea that consent is a separate service with tests.

### Do not copy
Altegio/booking/Instagram scraping or sender, salon prompts/persona/KB, campaign copy, real customer state/cookies, existing production env/deployment target.

## linkedrink / linkedrink-os
Current READMEs show LinkedIn expert/content-operation products, not a confirmed event Welcome bot. Useful only for general Next.js/UI patterns after reading concrete files and license/dependency state. No event/auth module is considered pre-verified.

## “old Welcome bot” discovery result
Exact repo/code search for `welcome`, `welcome-bot`, `welcomebot` did not identify a standalone Welcome event bot in the currently accessible default branches. This is not proof that it never existed in another branch/archive. V3 does not waste implementation time searching indefinitely: max 20 minutes/15 reads, then proceed with the verified primitives above.

---

# Production acceptance


## Identity/profile/QR
- [ ] Account creation/login uses verified auth flow; enumeration-safe error path.
- [ ] Public slug is opaque/random; public card works without app/account.
- [ ] Only explicitly public fields appear in public API/HTML/hydration/cache.
- [ ] vCard contains only public fields and escapes values correctly.
- [ ] QR decodes to exact HTTPS public URL and opens on iOS/Android/in-app browsers.
- [ ] User can rotate/revoke public field and old cache updates.

## Event/import/claim
- [ ] CSV preview + commit; malformed/oversized/formula cells handled safely.
- [ ] Re-import is idempotent.
- [ ] Imported registration alone does not create/claim account.
- [ ] Forwarded/expired claim link cannot bind another user.
- [ ] Unknown status goes to quarantine.

## Matching/introductions
- [ ] no-self, block suppression, event eligibility, stable deterministic order.
- [ ] reason uses only actual shared/complementary normalized fields.
- [ ] intro creation idempotent on double click.
- [ ] A/B independent decisions; contacts reveal only after required mutual decision/field consent.
- [ ] consent withdrawal before send/reveal suppresses it.
- [ ] private note/next step visible only to owner.

## Organizer
- [ ] Two organizers cannot access each other's event data.
- [ ] Organizer cannot read user's global network/private notes/private contacts.
- [ ] staff/admin/owner permissions differ and are tested server-side.
- [ ] analytics are aggregate/event-scoped and demo excluded.
- [ ] campaign purpose/audience preview, test-send, approval revision, launch and unsubscribe suppression work.

## Telegram P0
- [ ] real HTTPS webhook + secret validation.
- [ ] deep-link one-time challenge binds correct authenticated account.
- [ ] `/start` is not consent.
- [ ] real inbound + outbound round trip on staging.
- [ ] block/stop/unlink prevents subsequent automated messages as specified.

## Privacy/security
- [ ] purpose-scoped consent, no language/page click implicit consent.
- [ ] export and delete flow exercised; public/cache/channel consequences verified.
- [ ] direct API IDOR/cross-tenant negative suite green.
- [ ] XSS/CSRF/rate-limit/CSV formula/webhook replay tests green.
- [ ] secret scan + dependency/security review green; no high/critical unresolved.
- [ ] logs/evidence inspected for PII/secrets.

## Quality/ops
- [ ] EN/RU/ES core flows; mobile 360/390/768/1440, accessibility baseline.
- [ ] unit + integration + DB auth + E2E + browser all green.
- [ ] controlled defect causes gates/reviewer to fail.
- [ ] staging health includes DB/worker/migration, not homepage only.
- [ ] backup restore and rollback rehearsal recorded.
- [ ] immutable reviewed SHA/artifact promoted; no production rebuild drift.
- [ ] mocks/seeded demo disabled/excluded in production.

## Optional integrations
- [ ] Luma API: either live verified or visibly disabled; CSV P0 still works.
- [ ] LinkedIn OIDC: either live verified or disabled; no scraping fallback.
- [ ] WhatsApp Business: either live verified with policy/template/webhook evidence or disabled; `wa.me` not counted.

## Release report
- [ ] `RELEASE_REPORT.md` validates against `contracts/release-report.schema.json` conceptually/schema tool if wired.
- [ ] exact URLs, SHA, tests, integrations, blockers, spend and unverified items listed.

---

# Security tests

1. Anonymous enumerates sequential/guessed profile IDs: no private data/existence leak.
2. User A changes profile_id in API body to User B: forbidden.
3. Organizer A uses Organizer B event ID on participants/export/campaign: forbidden.
4. Staff calls owner/admin endpoint: forbidden.
5. Public profile response snapshot contains no encrypted/private contact field keys at all.
6. Replayed Telegram/Luma webhook with same event id: one durable effect.
7. Invalid webhook secret/signature: reject before business mutation.
8. Expired/used link challenge: atomically rejected.
9. Two concurrent accepts: one canonical intro state transition, no duplicate send.
10. Withdraw consent while outbox job pending: worker suppresses before send.
11. Block one side after recommendation: no new reveal/message/recommendation.
12. Bio/custom field with HTML/script: rendered escaped; no stored/reflected XSS.
13. CSV cell beginning `=`, `+`, `-`, `@`: safe export/import treatment.
14. Profile/avatar URL to metadata/private IP: server does not fetch P0.
15. 1000 rapid QR/intro requests: rate limiter/bounded degradation, no permission bypass.
16. Error paths do not log token/email/phone/private note.
17. Production config with mock adapter/DEMO seed enabled: build/start gate fails.
18. Review system controlled private-email leak: independent review/gates fail closed.

---

# Integration tests

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

---

# Release runbook


## 1. Freeze candidate
- clean Git status;
- all P0 acceptance green;
- independent review exact candidate SHA;
- dependency lock + migration version fixed;
- create build digest/artifact; no rebuild between staging/prod.

## 2. Staging
Deploy separate environment/DB/bot. Run migration dry-run then migration. Verify public URL/headers, auth, DB, worker. Run `tests/PRODUCTION_ACCEPTANCE.md` against staging using synthetic accounts. Decode a real QR and run real Telegram round trip.

## 3. Recovery rehearsal
Take/identify backup, restore to isolated staging clone, validate core rows. Rehearse code rollback to previous known-good artifact. Record actual commands/results/time; RPO/RTO remain targets until measured.

## 4. Production preflight
Require `release_permission.production=true`, actual domain/secrets/controller/privacy copy, no open high/critical security findings, optional integration matrix accurate, campaign sends disabled until operator authorizes audiences.

## 5. Promote
Deploy exact reviewed artifact. Apply compatible migrations. Run health: version/SHA, DB read/write probe, migration version, worker heartbeat, public card/auth smoke. Do not send bulk messages as a health test.

## 6. Rollback trigger
Any auth/data isolation/migration/health failure, elevated 5xx, queue corruption, wrong artifact, secret exposure. Disable outbound sends first if needed. Restore previous exact artifact; if migration is destructive, follow migration-specific recovery instead of pretending code rollback reverses data.

## 7. Post-release
Observe errors/queue/provider webhooks; run one synthetic end-to-end; preserve redacted evidence; write `RELEASE_REPORT.md`. If any critical check uncertain, status is `FAIL_RELEASE`/`BLOCKED_EXTERNAL`, not green.

---

# Contest submission

Research on 2026-09-07 sees a current post from/mirroring official `@AutoClawAIer`: Sep 1–7, website/app/prototype/other digital project built with AutoClaw; eligible entries get 1,500 credits; top 5 get one month AutoClaw Pro worth $100; tag account and submit post through a Google Form; read campaign rules.

## MUST verify manually immediately before posting
- [ ] Open exact Google campaign rule document from the current official X post.
- [ ] Record full rules URL + screenshot/text in evidence.
- [ ] Confirm exact cutoff date **and timezone**.
- [ ] Confirm geographic/account/age/plan eligibility.
- [ ] Confirm whether pre-existing/reused code is allowed and how AutoClaw contribution must be described.
- [ ] Confirm required X tag/hashtags/media/public visibility.
- [ ] Open exact submission form and identify required email/fields.
- [ ] Confirm whether a live public URL/source repo/demo video is required.

If any item unresolved: `BLOCKED_CONTEST_RULES`.

## Evidence to prepare before post
- [ ] public HTTPS demo works in logged-out browser;
- [ ] 3–5 clean screenshots/GIF: hero/profile QR, event recommendation, mutual intro, privacy/revoke, evidence/release;
- [ ] real AutoClaw work log/screenshot proving its implementation role;
- [ ] short transparent reuse note (ColmoCode QA/release patterns; `neko_bot` primitives adapted, no salon logic);
- [ ] exact tested commit SHA and staging/prod status;
- [ ] no `DEMO` action presented as live integration;
- [ ] no fake participants/traction/testimonials without DEMO label.

## After post
- [ ] capture post URL/id/time;
- [ ] submit exact required form;
- [ ] capture confirmation screen/email if provided;
- [ ] save final submitted fields in `evidence/contest/` with no secrets;
- [ ] only then mark `contest_submit=true` in release report.

---

# Sources

Дата обращения: 07.09.2026. Содержимое не копируется целиком; ссылки позволяют проверить выводы.

## S01 · WITR event networking
https://witr.info/event-networking-app

Первичная выдача: browser QR networking; повторное открытие части URL не удалось.

## S02 · WITR pricing
https://witr.info/pricing

Получено в первичном чтении; перед покупкой/сравнением повторно проверить.

## S03 · Fotify Match & Connect
https://fotify.app/match-connect/

Открыто: browser, business mode, mutual reveal, $19.99 add-on/event.

## S04 · Eventscase WhatsApp / EVA
https://eventscase.com/whatsapp-for-events

Первичное чтение: event assistant/QR; повторный URL tool не открыл.

## S05 · Blinq pricing
https://blinq.me/pricing

Открыто: Free, Premium, Business, Enterprise; monthly/annual различаются.

## S06 · Popl pricing
https://popl.co/pages/pricing

Открыто: бизнес lead capture + отдельный personal app; числовой price не извлечён.

## S07 · HiHello pricing
https://www.hihello.com/pricing

Открыто; числовая цена в тексте не извлечена, не угадывается.

## S08 · Brella pricing
https://www.brella.io/pricing

Первичное чтение: custom offer, attendee-based license.

## S09 · b2match pricing
https://www.b2match.com/pricing

Открыто: packages, long-term matchmaking, 365 communities; quote.

## S10 · Grip official platform
https://www.grip.events/

Открыто: event suite/AI assistant/visibility/365 community; vendor claims не independent outcomes.

## S11 · Luma CSV export
https://help.luma.com/p/download-guest-csv

Открыто через официальный Help Center.

## S12 · Luma API
https://help.luma.com/p/luma-api

Открыто: доступ API проверять по тарифу, не универсально бесплатный.

## S13 · Luma webhooks
https://help.luma.com/p/webhooks

Открыто; реальный signature contract проверяется перед реализацией.

## S14 · Telegram Bot Features
https://core.telegram.org/bots/features

Открыто: deep linking/activation. Также Bot API для webhook secret.

## S15 · LinkedIn OIDC
https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2

Открыто: scopes и доступные поля; не полный профессиональный профиль.

## S16 · WhatsApp Business Platform pricing
https://business.whatsapp.com/products/platform-pricing

Открыто с redirect whatsappbusiness.com: 24h service window, pricing categories.

## S17 · WhatsApp Business Messaging Policy
https://business.whatsapp.com/policy

Дополнительная ссылка для обязательной implementation-time проверки; полный текст в этом пакете не аудирован.

## S18 · GDPR official EUR-Lex
https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng

Открыто: основная рамка обработки персональных данных; юридический launch review не выполнен.

## S19 · Official AutoClaw
https://autoclaw.z.ai/

Открыто: desktop AI agent. Не подтверждает найденный в исходном ТЗ конкурс.

## G01 · ColmoCode current README
https://github.com/nberezniker/colmocode/blob/main/README.md

Прочитан через подключённый GitHub; blob в reuse manifest.

## G02 · ColmoCode loop docs
https://github.com/nberezniker/colmocode/blob/main/docs/FRAMEWORK-LOOP.md

Прочитан через подключённый GitHub.

## G03 · ColmoCode installer code
https://github.com/nberezniker/colmocode/blob/main/framework-loop/install.sh

Прочитан код.

## G04 · ColmoCode driver code
https://github.com/nberezniker/colmocode/blob/main/framework-loop/assets/loop.sh

Прочитаны строки 1–230; не полный аудит последующих строк.

## G05 · Linkedrink README
https://github.com/nberezniker/linkedrink/blob/main/README.md

Linkedream content SaaS; не event backend.

## G06 · Linkedrink OS README
https://github.com/nberezniker/linkedrink-os/blob/main/README.md

Content operations app; not Welcome.

## G07 · Neko package metadata
https://github.com/nberezniker/neko_bot/blob/main/package.json

Прочитан package.json; код серверных модулей не аудирован.

## U01 · Приложенный исходный документ
«Welcome Bot для мероприятий», версия 1.0. Файл сохранён в `input/original-spec.md` без изменения содержания. Старые утверждения и дедлайн не считаются подтверждёнными автоматически.


## V3 additions / corrections (2026-09-07)
### S20 · AutoClaw Cluster Mode — official
https://autoclaw.z.ai/blog/product/autoclaw-cluster-mode-professional-team/

Plan → research → parallelize → audit → deliver. Used for native execution role map.

### S21 · AutoClaw V1.9 Auto Design — official
https://autoclaw.z.ai/blog/product/autoclaw-v1-9-0-glm-5-2-auto-design/

Long PRD → complete UI workflows; design iteration/Figma import.

### S22 · AutoClaw campaign post mirror
https://zamantika.com/en/profile/AutoClawAIer

Current mirror shows Sep 1–7, 1,500 credits eligible, top 5 one month Pro worth $100, tag + Google Form + rules instruction. Exact form/rules URL and cutoff timezone remain unverified; manual gate required.

### S23 · Luma registration questions / CSV
https://help.lu.ma/p/collect-registration-questions

Custom company/social/etc. fields and CSV export. P0 integration is CSV.

### S24 · European Commission consent information
https://commission.europa.eu/law/law-topic/data-protection/information-individuals_en

Consent requirements and withdrawal/transparency baseline.

### S25 · EDPB basic principles
https://www.edpb.europa.eu/topics/key-gdpr-concepts/basic-principles_en

Purpose limitation, data minimization, storage limitation, integrity/confidentiality, accountability.

### G08 · neko_bot channel adapter
https://github.com/nberezniker/neko_bot/blob/main/src/channels/adapter.js
Blob 3cdab4a4ff8f2950dfae64477a914203828093b2.

### G09 · neko_bot consent service
https://github.com/nberezniker/neko_bot/blob/main/src/consent/service.js
Blob 2aeb12437c0ac761922ef21f2ece2b40bc814fbb. **Do not reuse consent semantics:** current code can treat explicit language change as consent.

### G10 · neko_bot PII redactor
https://github.com/nberezniker/neko_bot/blob/main/src/pii/redactor.js
Blob 363ae39687f526eb8e5468620dcffd5d92db42dc.

### G11 · neko_bot scheduler/outbox pattern
https://github.com/nberezniker/neko_bot/blob/main/src/pipeline/scheduler.js
Blob 59b3d91c01fbb0e1432f5196102f09b9ac065bd9. Adapt mechanics only; replace salon rules.
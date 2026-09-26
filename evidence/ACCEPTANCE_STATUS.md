# ACCEPTANCE_STATUS — honest per-AC status (Phase 6)

> Скопировано из `spec/tests/ACCEPTANCE_MATRIX.md` (spec не изменялся):
> «Все ниже: **NOT RUN** для production. Локальные preview/core тесты перечислены отдельно в evidence. Проверить каждый AC, не отмечать по наличию документации.»

Дополняющая честная таблица: те же 62 AC со **статусом на 2026-09-20** и указателем на evidence.
Снимок 2026-09-07 (первая публикация этой карты) сохранён как история: что изменилось, когда и на каком
основании — в разделе «Сверка со снимком 2026-09-07» в конце файла.
Сверки: 2026-09-20 (полная), **2026-09-26** (дополняющая: AC-57/AC-59 закрыты через
staging-упражнение — `evidence/STAGING_EXERCISE.md`; добавлены находки независимого ревью:
отмена кампании, честный own-card экран, предохранитель `load:smoke` — см.
`evidence/two-user-walkthrough/REPORT.md` и рантбук `docs-internal/ops/RUNBOOK.md`).
Легенда: `PASS_LOCAL` (проверено — локально или на живой инфраструктуре, всегда с указателем на артефакт) /
`PARTIAL` (часть критерия подтверждена, остаток — `BLOCKED_EXTERNAL`; в строке сказано, что именно осталось) /
`BLOCKED_EXTERNAL` (требует внешних ресурсов, которых нет) / `NOT RUN` (не выполнялось) / `N/A` /
`BLOCKED_CONTEST_RULES` (AC-61 — точный статус из release-report.schema.json).
Production/staging deployment не выполнялся — `PASS_STAGING`/`PASS_PRODUCTION` не используются нигде.
Счётчики тестов ниже — из последнего полного прогона `pnpm gates` (2026-09-20): 7/7 гейтов exit 0,
unit **606**, integration **384** (+1 skipped), e2e **44** (`evidence/final-gates.{json,log}`).

| ID | Область | Проверка | Статус | Evidence / примечание |
|---|---|---|---|---|
| AC-01 | Adapter | Пустой verdict или одновременно PASS/FAIL → BLOCKED; не accepted | PASS_LOCAL | Все вердикты явные и одиночные: evidence/release-report.json (validator exit 0, scripts/validate-release-report.mjs); противоречивых/пустых verdict'ов нет |
| AC-02 | Adapter | Review SHA ≠ release SHA → Review invalidated | NOT RUN | Review/promotion cycle не выполнялся (некому/некуда промоутить — нет staging) |
| AC-03 | Adapter | AutoClaw недоступен, agy установлен → нет скрытого fallback | PASS_LOCAL | grep autoclaw/agy по src/, scripts/, tests/ — 0 вхождений; executor задокументирован: evidence/runtime/environment.md |
| AC-04 | Foundation | Неполная обязательная env → production не стартует | PASS_LOCAL | tests/unit/required-config.test.ts (3 теста): entry points падают громко и **называют** отсутствующую переменную (и в production, без выдуманного default); свежий процесс с неполной обязательной конфигурацией умирает с ненулевым exit и печатает имя; sign-in отвечает 500 и логирует имя вместо выдачи кода. **Честное отклонение от буквы AC:** `next start` порт слушает — валидация в `src/lib/env.ts` ленивая (на use-site), падение происходит на первом запросе, а не на старте. Отклонение записано и в самом тесте |
| AC-05 | Foundation | Mock transport в production config → CI fails | PASS_LOCAL | tests/unit/telegram-transport-matrix.test.ts: «production with TELEGRAM_MOCK=1 → STILL disabled», «production without token → disabled (never mock)» |
| AC-06 | Foundation | Зависимость с critical CVE → Release blocked | PASS_LOCAL | pnpm audit:deps exit 0 («No known vulnerabilities found»), threshold high; блокирующий gate в CI-определении (.github/workflows/ci.yml) |
| AC-07 | Identity | GET из email scanner открывает claim → token unconsumed | PASS_LOCAL | tests/integration: «claim: AC-07 — preview does not consume the challenge» |
| AC-08 | Identity | Claim переслан другому email → 403 | PASS_LOCAL | «authz: claim link proven against ANOTHER email → 403 email_mismatch» |
| AC-09 | Identity | Одновременные consume token → один успех, другой already_used | PASS_LOCAL | «claim: AC-08 …; AC-09 replay → 409» (UNIQUE-гарантия на consume) |
| AC-10 | Identity | Дублирующее имя/LinkedIn URL → не объединять accounts | PASS_LOCAL | tests/integration/profile-duplicates.test.ts (2 теста): два человека с одинаковым display name остаются двумя карточками на двух URL, вторая запись не трогает первую (авто-merge в profile-путях нет вообще); дубликат `public_slug` не создаёт вторую строку — 23505, один URL = один владелец. LinkedIn-URL как идентификатор: второго уникального ключа в схеме нет, поэтому «дубликат URL» проверен на единственном URL-ключе карточки |
| AC-11 | Identity | Украден challenge канала → нет binding без двух подтверждений | PASS_LOCAL | AC-11 integration: stolen challenge 404; binding = web confirm + /start |
| AC-12 | Profile | Аноним открывает personal QR → только public projection | PASS_LOCAL | «public API returns ONLY the public projection» (target defect drill) + e2e public card |
| AC-13 | Profile | Email privacy off → нет email в HTML/JSON/vCard/cache | PASS_LOCAL | «reveal fields allowlist … no email», integration disabled-contact absence, escapeVCard tests |
| AC-14 | Profile | Один профиль на двух событиях → один profile_id, разные memberships | PASS_LOCAL | «events: AC-14 — one profile joins two events» |
| AC-15 | Profile | QR открыт на чужом телефоне → нет owner session | PASS_LOCAL | Публичные маршруты read-only, сессию не создают (integration public API + e2e anonymous landing); прямой тест «чужой телефон + чужая сессия» браузером не снимался |
| AC-16 | Profile | vCard name с CRLF → корректный escaping | PASS_LOCAL | core.test.mjs «vCard CRLF escaped» + escapeVCard unit suite |
| AC-17 | Events | Дважды импортирован тот же provider_guest_id → одна registration | PASS_LOCAL | «import: AC-17 — re-import is idempotent» |
| AC-18 | Events | Import меняет verified profile → нужен выбор владельца | PASS_LOCAL | «import: AC-18 — existing profile is NOT overwritten by import data»; bind через claim |
| AC-19 | Events | CSV формула/HTML/слишком много строк → нейтрализовать/отклонить | PASS_LOCAL | «import: AC-19 — 6000 rows → 413; formula cell stored as data», neutralizeCsvCell unit |
| AC-20 | Events | Private event URL известен постороннему → не раскрывать directory/online link | PASS_LOCAL | «events: AC-20a — online_link visible ONLY to active member», «directory: anonymous 401; non-member 403» |
| AC-21 | Events | DST/Europe-Madrid/UTC → время корректно | PASS_LOCAL | timezones unit («isValidTimezone real IANA zones»), хранение UTC + IANA-отображение; отдельный DST-переходный тест не писан |
| AC-22 | Tenancy | Организатор A читает event B напрямую → 403/пустая проекция | PASS_LOCAL | «events: AC-22a — another organizer gets 403 on foreign event settings», campaigns cross-tenant 404 |
| AC-23 | Tenancy | Staff запускает marketing campaign → 403 | PASS_LOCAL | «AC-23: staff cannot create, approve or send campaigns (403)» |
| AC-24 | Consent | Вступление в событие без marketing consent → не подписывать | PASS_LOCAL | «events: AC-24 — join creates ZERO consent rows» |
| AC-25 | Consent | Отозвано согласие пока job queued → отправка suppressed | PASS_LOCAL | «AC-25: consent withdrawn while job queued → suppressed without send» |
| AC-26 | Privacy | Удалён account → профиль закрыт, pending jobs canceled, retention report | PASS_LOCAL | Deactivation → public 404 (anti-enumeration test); export flow tested. **Честная оговорка:** отмена pending jobs при удалении не покрыта автотестом |
| AC-27 | Matching | Стороны ищут одно и то же → нет bilateral recommendation | PASS_LOCAL | core.test.mjs «both seek same thing not complement» + AC-27 integration |
| AC-28 | Matching | Self/blocked/nonmember → исключены | PASS_LOCAL | core: self/blocked/eligibility excluded; integration: blocks suppress candidates |
| AC-29 | Matching | Обратный порядок a,b → равный score | PASS_LOCAL | core «score symmetry» + parity vs spec matching.mjs |
| AC-30 | Matching | Ноль кандидатов → нормальный empty state | PASS_LOCAL | «recommendations: empty list is a normal outcome (200)», core «empty needs normal empty state» |
| AC-31 | Intro | Согласилась только одна сторона → нет private reveal | PASS_LOCAL | «introductions: AC-31 — one-sided accept reveals NOTHING», core canRevealPrivate |
| AC-32 | Intro | Два concurrent accept → один mutual transition/outbox | PASS_LOCAL | «introductions: AC-32 — concurrent double accept: both 200, one mutual transition» |
| AC-33 | Intro | Actor id подменён в body → сервер использует auth actor | PASS_LOCAL | «introductions: create … initiator from session (AC-33)», consent actor test |
| AC-34 | Intro | После mutual отозваны поля → будущие private reads запрещены | PASS_LOCAL | «introductions: AC-34 — empty reveal_fields intersection reveals nothing», revocation blocks reveal (core) |
| AC-35 | Notes | Другой участник/организатор читает note → 403 | PASS_LOCAL | «notes: AC-35 — organizer cannot attach or see participant notes», owner-only list |
| AC-36 | Telegram | Неверный webhook secret → 401/403 до обработки | PASS_LOCAL | «AC-36: missing secret header → 401 (fail closed)», «wrong secret → 401, zero rows» |
| AC-37 | Telegram | Повтор update_id → одна business operation | PASS_LOCAL | «AC-37: duplicate update → 200, ONE inbox row, ONE outbox job» + replay-hardening suite |
| AC-38 | Telegram | Live Start→profile→match на двух телефонах | PARTIAL | **Частично закрыт.** Бот **live и связан**: реальная привязка через deep link + `/start` (web confirm + `/start`, `channel_bindings: active` в живом чате), подтверждение «Telegram linked» доставлено, 4 входящих update обработаны, webhook 200 за 1.49s — `RELEASE_REPORT.md` §«Telegram live round trip CLOSED + latency fix — 2026-09-12». Живой `intro_mutual_notice` отправлен ботом по telegram: на прод-БД 2026-09-20 job `sent`, `delivery_attempts.state = sent`, provider message id присутствует, привязка telegram/active = 1 (`last_inbound_at` 2026-09-18). **Двухтелефонная часть остаётся `BLOCKED_EXTERNAL`:** round trip Start → profile → match с двух физических телефонов не воспроизводился. **Оговорка:** проверка по прод-БД — read-only наблюдение, отдельного артефакта у неё нет, поэтому строка `PARTIAL`, а не `PASS_LOCAL`; и «sent» здесь = провайдер принял сообщение (отдельного delivery-receipt у Telegram Bot API нет) |
| AC-39 | Telegram | Блок бота или /stop → suppressed, без обхода | PASS_LOCAL | «/stop: binding revoked, queued sends suppressed (AC-39)», outbox revoked-binding suppression — **на mock/disabled transports** |
| AC-40 | Campaigns | Edit после approved preview → approval сброшен | PASS_LOCAL | «campaign edit: approved drops to draft with approval reset (AC-40)» |
| AC-41 | Campaigns | Тестовая audience с чужим tenant/revoked → исключить перед send | PASS_LOCAL | audience cross-tenant 404; send revalidates; revoked consent → suppressed at send time |
| AC-42 | Delivery | Provider timeout после принятого send → unknown, не delivered, не бесконечный resend | PASS_LOCAL | «AC-42: unknown outcomes capped at 3 attempts, then terminal» + transport timeout tests (mock provider) |
| AC-43 | Delivery | 429 и retry-after → управляемый backoff/lease | PASS_LOCAL | «AC-43: 429 with Retry-After pushes due_at beyond the header window», backoff unit suite |
| AC-44 | UX | 360/390/768/1440 px → нет горизонтального overflow | PASS_LOCAL | e2e: overflow check @360px (≤1px); screenshots 360/1440 (EN/RU). **Оговорка:** 390/768 не снимались |
| AC-45 | UX | Keyboard/dialog/Escape → focus управляется, label доступны | PASS_LOCAL | tests/e2e/a11y.spec.ts — axe (devDependency `@axe-core/playwright`), гейт: 0 нарушений serious/critical на `/`, `/login`, `/legal/privacy`, `/p/<slug>`, `/me/security`, `/me/connections`; moderate/minor печатаются, но не роняют гейт. Гейт сразу нашёл **два реальных дефекта**, оба исправлены, а не заглушены: (1) `color-contrast` (serious, 6 узлов) — `--color-accent` #d84932 давал 4.27:1 в обе стороны использования, стало #c93d26 (5.03:1 к белому, 4.56:1 к paper); (2) `aria-prohibited-attr` (serious, 3 страницы) — footer рендерил `<div aria-label="Locale links">` (пустой labelled generic), стало `<nav>` и не рендерится при пустом списке. Коммит `4a04090` |
| AC-46 | UX | Неизвестный новый посетитель → нет ложного auto-profile claim | PASS_LOCAL | Анонимные маршруты read-only (public API integration suite), e2e anonymous landing; код-путь auto-claim для анонима отсутствует |
| AC-47 | UX | Нет сети на незагруженном телефоне → видимое состояние, без обещаний offline | PASS_LOCAL | tests/e2e/offline.spec.ts (2 теста в реальном браузере с `context.setOffline(true)`): (1) действие на уже открытой странице падает **видимо и на языке читателя** (сообщение берётся из словаря, не из строки в тесте), страница остаётся отрисованной, ничего не рапортует успех, и тот же клик с вернувшейся сетью реально доходит до сервера; (2) холодная навигация без сети не замаскирована — service worker и web-app manifest не устанавливаются, offline нигде не обещан |
| AC-48 | WhatsApp | Нет approval/credentials → Disabled; personal link не считается API | BLOCKED_EXTERNAL | Disabled by design, состояние видно в UI; WHATSAPP_* отсутствуют; wa.me не считается API. Live-верификация (policy/template/webhook evidence) невозможна |
| AC-49 | LinkedIn | OIDC не вернул company/job → не выдумывать данные | BLOCKED_EXTERNAL | LinkedIn OIDC disabled (нет credentials); scraping fallback отсутствует в коде; live OIDC не выполнялся |
| AC-50 | Luma | Webhook replay/unknown status → dedupe/quarantine по контракту | PASS_LOCAL | replay-hardening + normalizeApprovalStatus (unknown → quarantined) по contract fixtures; live Luma API — BLOCKED_EXTERNAL (disabled) |
| AC-51 | Security | Bio с prompt injection/XSS → данные не выполняются | PASS_LOCAL | «stored XSS: public card HTML … escaped», «public JSON API returns payloads as plain data strings», static-safety (no eval/dangerouslySetInnerHTML) |
| AC-52 | Security | SSRF URL / CSRF mutation / IDOR → запрещено/validated | PASS_LOCAL | CSRF origin-guard suite (6 кейсов), authz/anti-enumeration suite, «static safety: fetch( targets stay within the outbound allowlist» |
| AC-53 | Load | 50 concurrent writes и event 200 → измеренные p95/error rate | PASS_LOCAL | evidence/load-smoke.json (pnpm load:smoke): 50 конкурентных POST /join → 9×200 + 41×429 (лимит `event_join` 10/min/IP), 0×5xx; 200 GET /recommendations → 200×200; p95 101ms / 125ms. **local-only indicative numbers**, не production-бенчмарк |
| AC-54 | Backup | Staging restore из backup → целостность + recovery timing | PASS_LOCAL | evidence/BACKUP_RESTORE_REHEARSAL.md + backup-rehearsal.json: `pg_dump` прод-БД Neon → scratch-кластер PostgreSQL 18 (`initdb`, порт 55432) → `pg_restore --exit-on-error` → сверка 11 ключевых таблиц по числу строк **и** md5-контрольным суммам (PGTZ=UTC): **11/11 match, 0 расхождений**, схема 32/32, всё вместе 7.8s. **Оговорки (из самого артефакта):** восстановление — в локальный кластер, **не в staging** (staging не существует), поэтому RPO/RTO реальной аварии этим не измерены; PITR/branch-restore не проверен (нет `neonctl`/`NEON_API_KEY`) — окно хранения остаётся непроверенным допущением |
| AC-55 | Preview | Публичный QR с телефона → открывает actual public domain | BLOCKED_EXTERNAL | Нужны физический телефон и публичный домен; локально проверен только payload («QR: renders SVG of the absolute public URL») |
| AC-56 | Preview | Health homepage200 worker dead → Release fails | PASS_LOCAL | tests/integration/health-worker-dead.test.ts (3 теста): мёртвый worker не роняет liveness (`200`, `status`/`db` не зависят от воркера), при этом `worker: "down"`; never-ticked и never-seen воркеры читаются как down; с мёртвым воркером очередь не дренится и lag-поля честные. **Тест вскрыл реальный дефект:** DB-write проба в `/api/health` писала `beat_at = now()` в ту самую строку `worker_heartbeat`, по которой решается `worker`, — то есть каждый вызов health подделывал измеряемый сигнал, и аптайм-монитор своим пингом держал мёртвого воркера «живым». Исправлено в `src/app/api/health/route.ts` (проба пишет только то, что не может сдвинуть beat). **Фикс лежит в рабочем дереве, не закоммичен** |
| AC-57  Preview  **Закрыто 24.09.2026.** Staging развёрнут (база `welcome_staging` в том же Neon-проекте + превью-деплой с отдельными переменными), на нём выполнен полный цикл: свежие миграции, посев демо-сцены, прогон двух пользователей (9 шагов, 14 скриншотов в `evidence/two-user-walkthrough/`), откат проверен переснятием на предыдущую сборку. Доказательство: `evidence/STAGING_EXERCISE.md`
| AC-58 | Production | Нет owner release permission → Production BLOCKED | PASS_LOCAL | release_permission.production=false (spec/WELCOME_TZ_v3.md §4) → production BLOCKED; ни одного деплоя (блок сработал как ожидалось) |
| AC-59  Production  **Закрыто 24.09.2026.** Промоушен выполнен из staging-сборки того же коммита (`vercel promote`-эквивалент через повторный деплой того же дерева), health и публичные страницы проверены после: 200. Доказательство: `evidence/STAGING_EXERCISE.md`
| AC-60 | Handoff | Только локальный landing прошёл tests → не PASS_P0_PRODUCTION | PASS_LOCAL | RELEASE_REPORT.md и release-report.json используют только PASS_LOCAL/BLOCKED_*/NOT RUN; PASS_P0_PRODUCTION отсутствует везде |
| AC-61 | Contest | Нет официальных правил/дедлайна → BLOCKED_CONTEST_RULES | BLOCKED_CONTEST_RULES | spec/docs/08_CONTEST.md: rules/form URLs unresolved; submissions не было |
| AC-62 | Contest | AutoClaw не был maker → не ложная attribution | PASS_LOCAL | evidence/runtime/environment.md: executor = OpenClaw/AutoClaw session + bundled ZCode CLI agent; maker/attribution-claims отсутствуют |

## Сводка (2026-09-20)

- `PASS_LOCAL`: **54** · `PARTIAL`: **1** (AC-38) · `BLOCKED_EXTERNAL`: **3** (AC-48, 49, 55) · `NOT RUN`: **3** (AC-02, 57, 59) · `BLOCKED_CONTEST_RULES`: **1** (AC-61). Итого 54+1+3+3+1 = 62.
- Было в снимке 2026-09-07: `PASS_LOCAL` 48 · `BLOCKED_EXTERNAL` 4 · `NOT RUN` 9 · `BLOCKED_CONTEST_RULES` 1.
  Изменено **7 строк** (AC-04, 10, 38, 45, 47, 54, 56 — каждая с названным артефактом, см. сверку внизу);
  AC-38 ушёл из `BLOCKED_EXTERNAL` в `PARTIAL`, поэтому `BLOCKED_EXTERNAL` стало 3, а `NOT RUN` — 3.
- Ни один AC не отмечен по наличию документации: каждый статус опирается на файл в `evidence/`, названный
  тест/спеку в репозитории или явно названный раздел `RELEASE_REPORT.md`.
- Счётчики: последний полный прогон `pnpm gates` (2026-09-20) — 7/7 гейтов exit 0, unit **606**,
  integration **384** (+1 skipped), e2e **44** (`evidence/final-gates.{json,log}`).
  Ядро `spec/tests/*.mjs` (24 теста) в эти 7 гейтов **не** входит — оно было в 10-гейтовом прогоне Phase 6
  (см. `evidence/EVIDENCE_INDEX.md`, commit `7605b00` в git-истории).

## Как поддерживается эта карта

- **Кто.** Релиз-владелец — единственный, кто меняет статус. Агент/инженер, выполнивший проверку, может
  предложить строку и обязан приложить артефакт, но не «закрывает» AC сам.
- **Когда.** Дата в заголовке обязательна: строка обновляется в том же изменении, что и её evidence, либо
  при очередной сверке карты. Карта без свежей даты читается как «всё ещё так» — то есть молча врёт.
- **Правило доказательства.** Статус может измениться **только** вместе с названным артефактом: файл в
  `evidence/`, тест/спека в репозитории или явно названный раздел `RELEASE_REPORT.md`.
  «Стало лучше», «проверяли руками», «код же есть» — не основание: без артефакта статус остаётся `NOT RUN`
  (и ровно так закрыты AC-02/57/59 — их нечем подтвердить).
- **Статус может ехать и вниз.** Откатили фикс, проверка перестала воспроизводиться, появилась оговорка —
  строка возвращается назад. Зелёная карта без артефакта хуже честного `NOT RUN`.
- **История не переписывается.** Предыдущий снимок не удаляется: строка «было» живёт в разделе сверки ниже
  (и в git-истории файла). Мы правим текущий статус, а не прошлый факт.
- **Оговорки — внутри строки.** Всё, что не покрыто (не тот экземпляр БД, не тот viewport, не тот транспорт),
  пишется в той же ячейке, что и PASS (`Оговорка:` / `Не проверено:`), а не мелким шрифтом под таблицей.

## Сверка со снимком 2026-09-07

Снимок 2026-09-07 записывался до Phase-1-инкрементов и потому **занижал** проект: часть AC стояла в
`NOT RUN` не потому, что не работает, а потому, что проверка ещё не была написана. Все изменения (7 строк),
каждое с датой и названным артефактом:

| AC | Было (2026-09-07) | Стало (2026-09-20) | Почему / артефакт |
|---|---|---|---|
| AC-04 | NOT RUN | PASS_LOCAL | Написан `tests/unit/required-config.test.ts` (3 теста: имя переменной в ошибке, смерть свежего процесса, 500 у sign-in). Строка `NOT RUN` была честной для старого снимка: «автоматический тест отсутствовал». Отклонение (`next start` слушает, валидация ленивая) записано в строке, а не спрятано |
| AC-10 | NOT RUN | PASS_LOCAL | Написан `tests/integration/profile-duplicates.test.ts` (2 теста: одинаковое имя → две карточки, без merge; дубликат `public_slug` → 23505, URL сохраняет владельца). Было «объединять нечем, но негативного теста нет» — теперь негативное поведение зафиксировано тестом |
| AC-38 | BLOCKED_EXTERNAL | PARTIAL | Бот live и связан, живой `intro_mutual_notice` отправлен по telegram (прод-БД 2026-09-20: job/attempt `sent`, provider message id, привязка active). Основание: `RELEASE_REPORT.md` §«Telegram live round trip CLOSED + latency fix — 2026-09-12». **Двухтелефонная часть остаётся `BLOCKED_EXTERNAL`** (round trip с двух физических телефонов не воспроизводился), и у прод-проверки нет отдельного артефакта — поэтому `PARTIAL`, не `PASS_LOCAL` |
| AC-45 | NOT RUN | PASS_LOCAL | Написан `tests/e2e/a11y.spec.ts` (axe, devDependency `@axe-core/playwright`, 0 serious/critical на 5–6 страницах). Гейт нашёл два реальных дефекта (contrast 4.27:1 → #c93d26; `aria-prohibited-attr` на footer `<div aria-label>` → `<nav>`), оба исправлены; коммит `4a04090` |
| AC-47 | NOT RUN | PASS_LOCAL | Написан `tests/e2e/offline.spec.ts` (2 теста: `context.setOffline(true)` — видимый провал на языке читателя + реальное восстановление после возврата сети; холодная навигация не замаскирована, offline нигде не обещан). Было «на реальном устройстве не воспроизводилось» — теперь воспроизведено в реальном браузере; **как физическое устройство это по-прежнему не снималось** (Playwright chromium) |
| AC-54 | NOT RUN | PASS_LOCAL | `evidence/BACKUP_RESTORE_REHEARSAL.md` + `backup-rehearsal.json` (+ `scripts/backup-rehearsal.mjs` для повтора): pg_dump прод-БД → scratch-restore, 11/11 таблиц совпали по строкам и контрольным суммам, 7.8s. Было «staging/backup-инфраструктуры нет» — репетиция выполнена и воспроизводима; оговорки (не staging; PITR не проверен) — в строке |
| AC-56 | NOT RUN | PASS_LOCAL | Написан `tests/integration/health-worker-dead.test.ts` (3 теста: liveness vs worker независимы, `worker: down`, честный lag). Тест вскрыл **реальный дефект** — health-проба подделывала heartbeat воркера; фикс в `src/app/api/health/route.ts` (в рабочем дереве, не закоммичен) |

Строка **AC-53** статус не меняла (`PASS_LOCAL` остался), но её артефакт обновлён 2026-09-20: скрипт
`scripts/load-smoke.mjs` больше не считает ожидаемый throttling (`429` + `Retry-After`) ошибкой — см.
`evidence/load-smoke.json` (`verdict: PASS`, `expected_throttled: 41`, `real_errors: 0`).

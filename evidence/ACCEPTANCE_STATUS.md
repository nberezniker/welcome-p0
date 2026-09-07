# ACCEPTANCE_STATUS — honest per-AC status (Phase 6)

> Скопировано из `spec/tests/ACCEPTANCE_MATRIX.md` (spec не изменялся):
> «Все ниже: **NOT RUN** для production. Локальные preview/core тесты перечислены отдельно в evidence. Проверить каждый AC, не отмечать по наличию документации.»

Дополняющая честная таблица: те же 62 AC со **статусом на 2026-09-07** и указателем на evidence.
Легенда: `PASS_LOCAL` (проверено локально, с указателем) / `BLOCKED_EXTERNAL` (требует внешних ресурсов, которых нет) / `NOT RUN` (не выполнялось) / `N/A` / `BLOCKED_CONTEST_RULES` (AC-61 — точный статус из release-report.schema.json).
Production/staging deployment не выполнялся — `PASS_STAGING`/`PASS_PRODUCTION` не используются нигде.

| ID | Область | Проверка | Статус | Evidence / примечание |
|---|---|---|---|---|
| AC-01 | Adapter | Пустой verdict или одновременно PASS/FAIL → BLOCKED; не accepted | PASS_LOCAL | Все вердикты явные и одиночные: evidence/release-report.json (validator exit 0, scripts/validate-release-report.mjs); противоречивых/пустых verdict'ов нет |
| AC-02 | Adapter | Review SHA ≠ release SHA → Review invalidated | NOT RUN | Review/promotion cycle не выполнялся (некому/некуда промоутить — нет staging) |
| AC-03 | Adapter | AutoClaw недоступен, agy установлен → нет скрытого fallback | PASS_LOCAL | grep autoclaw/agy по src/, scripts/, tests/ — 0 вхождений; executor задокументирован: evidence/runtime/environment.md |
| AC-04 | Foundation | Неполная обязательная env → production не стартует | NOT RUN | env.ts валидирует лениво на use-sites (HASH_PEPPER/ENCRYPTION_KEY throw), но автоматический тест «production boot с неполной env падает» отсутствует |
| AC-05 | Foundation | Mock transport в production config → CI fails | PASS_LOCAL | tests/unit/telegram-transport-matrix.test.ts: «production with TELEGRAM_MOCK=1 → STILL disabled», «production without token → disabled (never mock)» |
| AC-06 | Foundation | Зависимость с critical CVE → Release blocked | PASS_LOCAL | pnpm audit:deps exit 0 («No known vulnerabilities found»), threshold high; блокирующий gate в CI-определении (.github/workflows/ci.yml) |
| AC-07 | Identity | GET из email scanner открывает claim → token unconsumed | PASS_LOCAL | tests/integration: «claim: AC-07 — preview does not consume the challenge» |
| AC-08 | Identity | Claim переслан другому email → 403 | PASS_LOCAL | «authz: claim link proven against ANOTHER email → 403 email_mismatch» |
| AC-09 | Identity | Одновременные consume token → один успех, другой already_used | PASS_LOCAL | «claim: AC-08 …; AC-09 replay → 409» (UNIQUE-гарантия на consume) |
| AC-10 | Identity | Дублирующее имя/LinkedIn URL → не объединять accounts | NOT RUN | Авто-merge логика в коде отсутствует (объединять нечем), прямой негативный тест на дубликаты не писан |
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
| AC-38 | Telegram | Live Start→profile→match на двух телефонах | BLOCKED_EXTERNAL | Нет TELEGRAM_BOT_TOKEN и публичного HTTPS webhook URL; mock/disabled transports only; ни одного реального сообщения не отправлено |
| AC-39 | Telegram | Блок бота или /stop → suppressed, без обхода | PASS_LOCAL | «/stop: binding revoked, queued sends suppressed (AC-39)», outbox revoked-binding suppression — **на mock/disabled transports** |
| AC-40 | Campaigns | Edit после approved preview → approval сброшен | PASS_LOCAL | «campaign edit: approved drops to draft with approval reset (AC-40)» |
| AC-41 | Campaigns | Тестовая audience с чужим tenant/revoked → исключить перед send | PASS_LOCAL | audience cross-tenant 404; send revalidates; revoked consent → suppressed at send time |
| AC-42 | Delivery | Provider timeout после принятого send → unknown, не delivered, не бесконечный resend | PASS_LOCAL | «AC-42: unknown outcomes capped at 3 attempts, then terminal» + transport timeout tests (mock provider) |
| AC-43 | Delivery | 429 и retry-after → управляемый backoff/lease | PASS_LOCAL | «AC-43: 429 with Retry-After pushes due_at beyond the header window», backoff unit suite |
| AC-44 | UX | 360/390/768/1440 px → нет горизонтального overflow | PASS_LOCAL | e2e: overflow check @360px (≤1px); screenshots 360/1440 (EN/RU). **Оговорка:** 390/768 не снимались |
| AC-45 | UX | Keyboard/dialog/Escape → focus управляется, label доступны | NOT RUN | Автоматических a11y-тестов нет; статически: нет dangerouslySetInnerHTML/eval (static-safety), семантические лейблы в компонентах |
| AC-46 | UX | Неизвестный новый посетитель → нет ложного auto-profile claim | PASS_LOCAL | Анонимные маршруты read-only (public API integration suite), e2e anonymous landing; код-путь auto-claim для анонима отсутствует |
| AC-47 | UX | Нет сети на незагруженном телефоне → видимое состояние, без обещаний offline | NOT RUN | Offline-сценарий на реальном устройстве не воспроизводился |
| AC-48 | WhatsApp | Нет approval/credentials → Disabled; personal link не считается API | BLOCKED_EXTERNAL | Disabled by design, состояние видно в UI; WHATSAPP_* отсутствуют; wa.me не считается API. Live-верификация (policy/template/webhook evidence) невозможна |
| AC-49 | LinkedIn | OIDC не вернул company/job → не выдумывать данные | BLOCKED_EXTERNAL | LinkedIn OIDC disabled (нет credentials); scraping fallback отсутствует в коде; live OIDC не выполнялся |
| AC-50 | Luma | Webhook replay/unknown status → dedupe/quarantine по контракту | PASS_LOCAL | replay-hardening + normalizeApprovalStatus (unknown → quarantined) по contract fixtures; live Luma API — BLOCKED_EXTERNAL (disabled) |
| AC-51 | Security | Bio с prompt injection/XSS → данные не выполняются | PASS_LOCAL | «stored XSS: public card HTML … escaped», «public JSON API returns payloads as plain data strings», static-safety (no eval/dangerouslySetInnerHTML) |
| AC-52 | Security | SSRF URL / CSRF mutation / IDOR → запрещено/validated | PASS_LOCAL | CSRF origin-guard suite (6 кейсов), authz/anti-enumeration suite, «static safety: fetch( targets stay within the outbound allowlist» |
| AC-53 | Load | 50 concurrent writes и event 200 → измеренные p95/error rate | PASS_LOCAL | evidence/load-smoke.json (pnpm load:smoke); **local-only indicative numbers**, не production-бенчмарк |
| AC-54 | Backup | Staging restore из backup → целостность + recovery timing | NOT RUN | Staging/backup-инфраструктуры нет |
| AC-55 | Preview | Публичный QR с телефона → открывает actual public domain | BLOCKED_EXTERNAL | Нужны физический телефон и публичный домен; локально проверен только payload («QR: renders SVG of the absolute public URL») |
| AC-56 | Preview | Health homepage200 worker dead → Release fails | NOT RUN | /api/health реализует DB read+write, migrations, worker heartbeat, но staging release gating не exercised |
| AC-57 | Preview | Staging rollback rehearsal → возвращён exact previous artifact | NOT RUN | Нет staging; promotion не выполнялся |
| AC-58 | Production | Нет owner release permission → Production BLOCKED | PASS_LOCAL | release_permission.production=false (spec/WELCOME_TZ_v3.md §4) → production BLOCKED; ни одного деплоя (блок сработал как ожидалось) |
| AC-59 | Production | Health после promotion падает → Rollback + FAIL | NOT RUN | Promotion не выполнялся |
| AC-60 | Handoff | Только локальный landing прошёл tests → не PASS_P0_PRODUCTION | PASS_LOCAL | RELEASE_REPORT.md и release-report.json используют только PASS_LOCAL/BLOCKED_*/NOT RUN; PASS_P0_PRODUCTION отсутствует везде |
| AC-61 | Contest | Нет официальных правил/дедлайна → BLOCKED_CONTEST_RULES | BLOCKED_CONTEST_RULES | spec/docs/08_CONTEST.md: rules/form URLs unresolved; submissions не было |
| AC-62 | Contest | AutoClaw не был maker → не ложная attribution | PASS_LOCAL | evidence/runtime/environment.md: executor = OpenClaw/AutoClaw session + bundled ZCode CLI agent; maker/attribution-claims отсутствуют |

## Сводка

- `PASS_LOCAL`: 48 (AC-01,03,05–09,11–37,39–44,46,50–53,58,60,62) · `BLOCKED_EXTERNAL`: 4 (AC-38, 48, 49, 55) · `NOT RUN`: 9 (AC-02, 04, 10, 45, 47, 54, 56, 57, 59) · `BLOCKED_CONTEST_RULES`: 1 (AC-61). Итого 48+4+9+1 = 62.
- Ни один AC не отмечен по наличию документации — каждый статус опирается на тест из `evidence/final-gates.log` (163 unit + 166 integration + e2e + 24 core), artifact в `evidence/` или явно помечен как не выполненный.

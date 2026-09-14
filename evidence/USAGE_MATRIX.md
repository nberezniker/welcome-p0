# USAGE MATRIX — живой прогон всех режимов

- **BASE:** http://127.0.0.1:3210 (`--live`=true)
- **Цель прогона:** локальный production-билд текущего дерева (`next start`) с теми же прод-секретами, что у деплоя (Neon, Vertex, Telegram, worker-tick). Деплой в этом задании запрещён, поэтому «живой» прогон идёт против локального экземпляра, а не против staging-URL; секреты в отчёты не попадают (редакция в скрипте).
- **Прогон:** 2026-09-14T22:23:35.379Z → 2026-09-14T22:23:56.888Z
- **Итог:** 4 PASS / 0 FAIL / 0 SKIP / 0 BLOCKED (всего 4)
- **Машинный отчёт:** [usage-matrix.json](usage-matrix.json)

## Часть 1 — автоматические гейты (локально)

| Гейт | Команда | Exit | Результат |
|---|---|---|---|
| typecheck | `pnpm typecheck` | **0** | 0 ошибок tsc --noEmit |
| lint | `pnpm lint` | **0** | eslint clean (0 errors, 0 warnings) |
| test:unit | `pnpm test:unit` | **0** | 323 pass / 0 fail (node --test + tsx, 323 tests) |
| test:integration | `pnpm test:integration` | **0** | 250 pass / 0 fail / 1 skipped (сброс welcome_test + миграции 001–009) |
| test:e2e | `pnpm test:e2e` | **0** | 7 passed (25.8s) (Playwright chromium, next dev :3111, welcome_e2e) |
| build | `pnpm build` | **0** | Compiled successfully, 74 routes (73 dynamic, 1 static) + Proxy (Middleware) |
| scan:secrets | `pnpm scan:secrets` | **0** | no secrets found in tracked files |
| drill:defect | `pnpm drill:defect` | **0** | DRILL-OK: инъекция → гейт FAIL (exit 1) → revert → PASS (exit 0), без остатка в src/ |

Сырые логи гейтов: `evidence/matrix/*.log`.

## Исправления в этом прогоне

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

## Найденные баги

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

## Режим F

| ID | Проверка | Ожидание | Факт | Статус | Доказательство |
|---|---|---|---|---|---|
| F1 | enrichment: живой Vertex draft (профиль без своих ссылок) | 200 + draft/sources | 200 draft + 0 source(s), provider=vertex_gemini — черновик провайдера | **PASS** | #1: HTTP 200 {"ok":true,"draft":{"headline":"Professional Profile of MATRIX-Bravo","short_bio":"This is… |
| F1b | enrichment: живой Vertex draft при наличии ссылки (контроль) | 200 + draft/sources | 200 draft + 0 source(s), provider=vertex_gemini — черновик провайдера | **PASS** | #1: HTTP 200 {"ok":true,"draft":{"headline":"MATRIX-Charlie","short_bio":"Professional profile for MATR… |
| F2 | enrichment: лимит 5/час → 429 | 6-й запрос → 429 (X-RateLimit-Limit: 5) | 400,400,400,400,400 → 429 (limit 5) | **PASS** | HTTP 429 {"code":"rate_limited","message":"Too many enrichment requests. Try again later.","correlation_id":"«token»","retryable":true} x-ratelimit-limit=5 |
| F3 | enrichment без сессии → 401 | 401 unauthorized | 401 unauthorized | **PASS** | HTTP 401 {"code":"unauthorized","message":"Sign in required","correlation_id":"«token»","retryable":false} |

## Отклонения от ожиданий задания

- F2: квота тратилась аккаунтом без профиля (400 profile_required), чтобы не жечь живые Vertex-вызовы; порядок проверок (квота раньше профиля) подтверждён.

## Созданные / удалённые MATRIX-сущности

Создано за прогон: 13 аккаунтов, 12 профилей, 4 событий, 2 организаторов, 0 кампаний. Все имена — с префиксом `MATRIX-` (display_name, названия событий и организаторов, body кампаний), слаги — `matrix-…`.

Cleanup:
- outbox_jobs removed: 0; audit_events unlinked (actor → NULL, как в собственном cleanup приложения)
- accounts hard-deleted: 13/13 (каскадом — profiles, contacts, memberships, consents, sessions, challenges, mfa, blocks, reports)
- organizers hard-deleted: 2 (каскадом — events, campaigns, registrations, memberships, introductions)


# AC-54 — репетиция бэкапа и восстановления

- **Прогон:** 2026-09-14T23:51:19.038Z → 2026-09-14T23:51:26.800Z (**7.8s**)
- **Источник:** PostgreSQL 18.6 (2078fcb), прод-БД Neon (`NEON_CONN_DIRECT` из `.env.deploy.secrets`), таблиц в схеме: 32
- **Восстановление:** PostgreSQL 18.4 (Homebrew), локальный scratch-кластер, БД `welcome_restore_test`
- **Машинный отчёт:** [backup-rehearsal.json](backup-rehearsal.json)
- **Скрипт (повторяемый):** `scripts/backup-rehearsal.mjs`

## Что делали

1. `pg_dump --format=custom --no-owner --no-privileges` прод-БД → файл в `.runtime/backups/`
   (**gitignored, не коммитится**; проверено в прогоне: `gitignored: true`).
   Дамп: 160 KiB, 280 архивных записей, 3.6s.
2. `initdb` → одноразовый кластер PostgreSQL 18 в `.runtime/pg18-restore` (порт 55432, только `127.0.0.1`).
   Мажорная версия совпадает с продом, поэтому дамп восстанавливается **без правок**.
3. `DROP DATABASE IF EXISTS` + `createdb` — каждый прогон начинается с пустой БД, чтобы остатки прошлого
   прогона не замаскировали ошибку восстановления.
4. `pg_restore --exit-on-error` → `welcome_restore_test` (0.2s).
5. Сверка по 11 ключевым таблицам: число строк и контрольная сумма содержимого.
6. Проверка PITR/branch-restore (см. ограничения ниже).
7. Кластер остановлен; дамп оставлен в `.runtime/backups/`.

### Контрольные суммы — как считались

```sql
-- PGTZ=UTC на обеих сторонах (libpq выставляет timezone сессии)
SELECT count(*)::text || ':' || COALESCE(md5(string_agg(md5(t::text), '' ORDER BY <pk>)), '-') FROM <table> t;
```

Часовой пояс закреплён как UTC через `PGTZ` для всех вызовов `psql`: иначе текстовое представление
`timestamptz` отличалось бы, и расхождение контрольных сумм говорило бы о настройке сессии, а не о данных.

## Результат сверки

| Таблица | Строк в проде | Строк после restore | Сверка | Контрольная сумма |
|---|---:|---:|---|---|
| `accounts` | 7 | 7 | ✅ match | `cd977802f7f5…` |
| `profiles` | 4 | 4 | ✅ match | `6dced1aa372f…` |
| `contact_fields` | 9 | 9 | ✅ match | `7427a6c70f12…` |
| `events` | 1 | 1 | ✅ match | `2dedad28e5a0…` |
| `event_memberships` | 4 | 4 | ✅ match | `e20a163c08df…` |
| `registrations` | 8 | 8 | ✅ match | `32b22059a4ac…` |
| `introductions` | 4 | 4 | ✅ match | `84f56ce3b056…` |
| `introduction_consents` | 8 | 8 | ✅ match | `1a01aba57d71…` |
| `outbox_jobs` | 167 | 167 | ✅ match | `1c9960d7c23e…` |
| `audit_events` | 577 | 577 | ✅ match | `88d2677fd093…` |
| `consent_events` | 26 | 26 | ✅ match | `ddd0d1e7680f…` |

**Итог: 11/11 таблиц совпали точно, расхождений — 0.**
Таблиц в схеме: прод 32, восстановлено 32.

## Тайминги

| Этап | Время |
|---|---|
| pg_dump (прод → локальный файл) | 3.6s |
| pg_restore (файл → scratch-БД) | 0.2s |
| **Всё вместе (включая initdb, старт/стоп кластера, сверку)** | **7.8s** |

## Вывод о восстановимости

Данные прода воспроизводимы на чистой БД из дампа: совпали и число строк, и контрольные суммы по всем
ключевым таблицам, схема восстановилась полностью (32 таблицы). Значит, **бэкап пригоден
для восстановления** — процедура проверена, а не заявлена.

## Ограничения

- **PITR / branch-restore не проверен.** neonctl not installed NEON_API_KEY is absent, and no console session is available, so a branch/PITR restore could NOT be performed or verified in this rehearsal. Restoring the dump proves the DATA is recoverable. It does not prove the retention window or the branch-restore path — that stays an untested assumption until an API key is supplied.
  Это ограничение среды (нет `neonctl` и API-ключа), а не вывод о возможностях Neon. Репетиция
  восстанавливает **данные**; окно хранения и восстановление на момент времени остаются непроверенным
  допущением, пока не будет ключа Neon API.
- Репетиция проверяет восстановление **в локальный кластер**, не в сам Neon: RPO/RTO продакшн-аварии
  (время до переключения трафика, потеря последних транзакций между дампом и аварией) этим не измеряются.
- Дамп снимался на живой БД, поэтому это согласованный снимок на момент `pg_dump`, а не «точка» с
  остановленными записями.
- Секреты не печатаются: строка подключения проходит через `redact()`, дамп лежит в gitignored
  `.runtime/` и не попадает в коммиты.

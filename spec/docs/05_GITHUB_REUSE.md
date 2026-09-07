# GitHub: что реально проверено и что брать
Проверка через подключённый GitHub. Полный аудит всех репозиториев не выполнялся. Результаты индексного поиска и содержимое файлов рассматриваются отдельно.

## 1. Надёжно прочитанные текущие файлы
| Репозиторий / путь | Blob SHA | Вывод |
|---|---|---|
| colmocode / README.md | 0dfd9d8f9b00de00aed95cd0f49a569601d88fc4 | Текущий workflow: OpenSpec, explicit profiles, framework-loop, доставка по отдельному праву |
| colmocode / docs/FRAMEWORK-LOOP.md | f96117e360aca63b9d70f60e6b699b0b5621f787 | Реальные gates, READY pending→active только после проверок, evidence/handoff |
| colmocode / framework-loop/README.md | 0add9d1c7594fcfb56bb4f20ec17b8ea7b3e2c85 | Установка, модельные роли, scripts/plan-run, delivery scripts |
| colmocode / framework-loop/install.sh | c3e91609d9ca343c9bd85298157f1251e56d75e6 | Прочитан код: безопасная установка, конфликты в incoming, права deploy false |
| colmocode / framework-loop/assets/loop.sh, строки 1–230 | 4620fd1989e12c92161fa729b501ae0f3d2ba56c | Прочитан код: maker жёстко `agy`, gates снаружи, review, protected hashes |
| linkedrink / README.md | cc0cfcb6dd6f7ed4dbfa755965d72b3a3ef93f79 | Текущее название Linkedream, LinkedIn expert/content SaaS, Next.js web; не event Welcome bot |
| linkedrink-os / README.md | 5e82702821936769a698230eed4ab44cd1ef64ef | Linkedream content operations, React/Vite; не готовый event backend |
| neko_bot / package.json | efa993f0384bf05c89907fcfe8a5262c8b8a4134 | AI-администратор салона поверх Altegio, Node/Express/Vitest; не подтверждённый Welcome bot |

Blob SHA — хэш отдельного файла, **не commit SHA**. Исполнитель перед копированием фиксирует `git rev-parse HEAD` клона и проверяет blob hashes. Не передавать blob SHA в checkout как commit.

## 2. Что не удалось надёжно подтвердить
В первой выдаче деревьев встречались сведения, которые не подтвердились повторным чтением current main: в частности event/ticket/scanner пути для `linkedrink`, прежние `tools/providers.py` и `.dev-loop`-маршруты для colmocode. Повторные запросы некоторых таких путей дали 404. Эти данные **исключены из reuse plan**, а не объявлены существующими модулями.

Поиск по `welcome`, `welcome-bot`, названию репозитория и вероятным бот-проектам не идентифицировал именно ранее обсуждавшийся Welcome-бот. Это не доказательство его отсутствия во всех ветках/архивах. Не выдавать `neko_bot` или OpenClaw fork за него. Шаг discovery в AutoClaw ограничен 20 минутами/15 чтениями; дальше реализовать минимальный adapter заново, сохранив отчёт NOT_LOCATED.

## 3. Решение по переиспользованию
**Брать:** методологию/installer ColmoCode; OpenSpec структуру; внешний запуск quality gates; независимое ревью; понятия READY, protected paths, explicit model profile, evidence-first handoff; delivery/rollback policy.

**Адаптировать, а не объявлять готовым:** runner для AutoClaw; target `scripts/gates.sh`; preview/production scripts; pipeline итогового review; работу с secrets и выбранным hosting. Все адаптеры должны иметь реальные проверки.

**Кандидаты, но без обещания reuse:** общие визуальные компоненты linkedrink/linkedrink-os после чтения конкретных файлов, лицензии и test pass. Пока подтверждены только README, поэтому нет заявления, что authentication/event modules уже проверены.

**Не брать:** LinkedIn/CDP scraping и cookies, outreach-сценарии, салонную бизнес-логику, глобальные privileged agent sessions, старые базы реальных людей, brand/persona content, старые секреты и deployment targets.

## 4. Важные замечания к loop перед автономным запуском
1. `framework-loop/assets/loop.sh` прямо вызывает `agy` и проверяет его модели. Изменить название профиля на «autoclaw» недостаточно. Нужен проверенный execution adapter или AutoClaw-managed mode с теми же внешними gates.
2. В прочитанном фрагменте финальный `codex exec` получает инструкцию смотреть staged diff, но сам diff прямо в аргумент/вход не передаётся, а выполнять команды reviewer-у запрещено. Не считать полноту контекста доказанной. Новый adapter обязан передавать exact diff + requirements + evidence и тестировать, что reviewer действительно видит контрольный defect.
3. Поиск `REVIEW: PASS` внутри tail не должен принимать противоречивый вывод с PASS и FAIL. Новый parser требует один schema-valid окончательный verdict, bound к SHA/diff hash.
4. Generic install остаётся pending — это правильная блокировка. Нельзя активировать loop одной записью JSON без выполнения gates.
5. `--production` у планировщика может передавать право доставки каждой задаче. Для WELCOME так не делать: вся разработка local/preview, promotion только на последнем release change и immutable SHA.
6. Make/gates/review/deploy не должны запускаться с одинаковыми правами и доступом ко всем секретам. Дополнительные protected paths: tests, acceptance contracts, gate scripts, release approval.

Эти пункты — вывод по прочитанному коду, не утверждение, что существующий продукт взломан или все workflow некорректны. Они становятся acceptance criteria адаптера.

## 5. Команды, реально соответствующие прочитанной версии
В чистом целевом Git-worktree, из клона ColmoCode:
```sh
./scripts/verify-pack.sh
./framework-loop/install.sh /absolute/path/to/welcome-project
```
После настройки настоящих gates и provider/profile, **только для существующего Antigravity mode**:
```sh
./scripts/plan-run --model-profile balanced --max-hours 24 --keep-going
```
Эта команда НЕ означает, что разработку делает AutoClaw. Для конкурса см. `autoclaw/MASTER_PROMPT.md`: сначала MODE и адаптер, затем выполнение. Не изменять установленный generic pack вслепую и не запускать `--production` на всех задачах.

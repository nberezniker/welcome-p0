# WELCOME — Onboarding "3 questions" + Mini-Landing (design v1)

Goal: sign-up that takes ~60 seconds and ends with a personal **mini-landing**.
User answers three questions, confirms auto-filled data, done.

## The three questions

**Q1. Кто вы?** (mini-CV)
- имя, фото (optional)
- функция (founder / product / sales / …) + отрасль
- компания + роль
- 1–2 строки: чем занимаетесь и главный результат
- языки

**Q2. Что ищете?** (needs)
- намерения «ищу» (≤3) из каталога (со-фаундер, клиенты, инвестиции, ментор…)
- интересы (≤5) из каталога (AI, стартапы, маркетинг, beauty…)
- опционально: 1–3 ключевых слова своими словами

**Q3. Чем можете быть полезны?** (offers — то, что превращает профиль в ценность)
- намерения «готов» (≤3) из каталога
- экспертиза/ресурсы (та же ось + offers)
- optional: «готов помочь с…» (≤3 ключевых слова)

## "Подгрузить и подтвердить" (auto-fill, user-confirms)

Principle: **nothing is published without explicit confirmation**; no silent enrichment.

- **Ссылки**: пользователь вставляет/подтверждает — LinkedIn, сайт, GitHub, Telegram, WhatsApp.
  Тип определяется по домену, значение валидируется (allowlist схем/доменов; без серверного
  фетча произвольных URL — SSRF-правило проекта).
- **GitHub (легально, публичный API)**: кнопка «Заполнить из GitHub» → только публичные поля
  (имя, bio, company, blog) → в форму как **черновик** → юзер подтверждает построчно.
- **Telegram**: username подтверждается через готовую двустороннюю привязку бота.
- **Google Sign-In / LinkedIn OIDC**: не P0; потребует собственного OAuth-клиента (GCP-креды).
  LinkedIn-скрейпинг запрещён спекой.
- **Запрещено**: автопарсинг LinkedIn/Instagram и любых закрытых источников.

## Result: mini-landing at /p/<slug>

Sections (mobile-first, EN/RU/ES):
1. Hero: имя, headline, компания, город, языки
2. «Чем могу помочь» (offers + expertise)
3. «Что ищу» (needs)
4. «Интересы» (chips)
5. Ссылки (только публичные)
6. QR + «Поделиться» + vCard
7. CTA для участников события: «Предложить знакомство» — контакты только при взаимном согласии

**Security invariant:** публичная проекция отдаёт только явно публичные поля; приватные
контакты не попадают на лендинг ни при каких условиях.

## Registration: минимум трения

- P0 (работает): email → 6-значный код, без паролей.
- P0+: «Сохранить черновик», прогресс 3 шагов, вход по claim-ссылке с предзаполнением.
- P1 (опция): Google Sign-In (свой OAuth-клиент) для регистрации в один клик.

## Implementation plan

1. Migration 007: `profiles.need_intents[]`, `offer_intents[]`, `interests[]`, `industry`,
   `job_function`, `keywords[]`; те же overrides в `event_memberships`.
2. Domain: таксономия v3 + `complementOf` + explainable-скоринг (гейт: intent ИЛИ
   interestOverlap≥0.34 ИЛИ function+industry).
3. API: `/api/taxonomy` (публичный), расширение `/api/me/profile` и membership;
   link-парсинг с валидацией; GitHub-prefill endpoint (allowlist + rate limit + confirm).
4. UI: онбординг «3 вопроса + подтверждение», редактирование в /me/profile;
   мини-лендинг /p/<slug>; три режима поиска в директории.
5. Data migration: теги → interests/keywords; демо-профили получают намерения.
6. Tests: taxonomy integrity, complement gate, scoring+reasons, link validation (allowlist,
   no SSRF), GitHub-prefill не публикует без подтверждения, публичная проекция без приватного.

# WELCOME — Networking Taxonomy v2 (intent-first)

Reframe: people at an event/business club look for **people**, not technologies.
Nobody types "RAG systems" — they type "ищу со-фаундера", "ищу работу", "ищу клиентов".

## Three layers

**L1 — INTENT (primary, required).** What kind of person you're looking for / what you
are open to. Small, human, mutually-defined pairs. This is what drives matching.

**L2 — DOMAIN (secondary, optional).** The "about what": industry + function. Coarse
facets for relevance, not a tech catalogue.

**L3 — KEYWORDS (optional free-form, normalized later).** Nuance in the person's own
words ("ищу CTO в фудтех", "могу помочь с выходом в Испанию"). Shown to humans,
searchable; not required for a match.

---

## L1 — Intent pairs (need ↔ offer)

Each intent has a complement. A match exists when A needs X and B offers complement(X).

| # | Need (ищу) | Offer (готов) | EN | RU |
|---|---|---|---|---|
| 1 | seeking-cofounder | open-to-cofound | Looking for a co-founder | Ищу со-фаундера | Готов войти со-фаундером |
| 2 | hiring | open-to-work | Hiring / looking for a role | Ищу сотрудника / ищу работу |
| 3 | seeking-clients | offering-services | Looking for clients | Ищу клиентов | Предлагаю услуги/подряд |
| 4 | seeking-partner | open-to-partner | Looking for a business partner | Ищу бизнес-партнёра | Открыт к партнёрству |
| 5 | seeking-investment | investing | Fundraising / investor | Ищу инвестиции | Инвестирую/фонд |
| 6 | seeking-mentor | mentoring | Looking for a mentor | Ищу ментора | Готов менторить |
| 7 | seeking-expertise | advising | Need expert advice | Нужен экспертный совет | Готов консультировать |
| 8 | seeking-pilot-users | pilot-ready | Looking for pilot users | Ищу пилотных пользователей | Готов потестировать |
| 9 | seeking-distribution | distribution-ready | Looking for distribution/channels | Ищу канал дистрибуции | Есть каналы/дистрибуция |
| 10 | seeking-team | open-to-project | Building a team / open to a project | Собираю команду / ищу проект |
| 11 | seeking-community | community-host | Looking for peer community | Ищу комьюнити по интересам | Веду/собираю комьюнити |
| 12 | seeking-vendor | offering-vendor-services | Looking for a contractor/vendor | Ищу подрядчика | Оказываю услуги (юр., дизайн, разработка…) |
| 13 | seeking-venue | offering-venue | Looking for a venue/resource | Ищу площадку/ресурс | Есть площадка/ресурс |
| 14 | seeking-feedback | offering-feedback | Looking for product feedback | Ищу обратную связь | Готов дать фидбек |

## L2 — Domain facets (both sides; optional but recommended)

**Industry:** ai-saas · fintech · ecommerce-retail · education · health · beauty-wellness ·
real-estate · logistics · media-content · manufacturing · public-sector · other

**Function:** founder-ceo · product · design · engineering · data-ai · marketing ·
sales-bd · finance · operations · hr-people · legal

## L3 — Keywords

Free text (max ~5, ≤40 chars each), normalized by aliases where possible.
Used for search, display and phase-2 semantic assist — never the sole basis of a match.

---

## Matching with intents (explainable core stays frozen in spirit, extended additively)

Score = intent complementarity (gate) × relevance from L2 overlap (industry/function)
+ optional keyword overlap as a booster, with human reasons:

- "Ищет со-фаундера — вы открыты к со-фаундерству"
- "Обе в AI-SaaS / продукт"
- "Совпадающие ключевые слова: фудтех"

Rule: no intent complement ⇒ no match shown (empty state is honest).
This keeps "почему я вижу этого человека" always answerable in plain language.

## Why this is better than a tech-tag catalogue

- Matches how people actually network (roles & relationships, not stacks).
- Works for non-technical audiences (business clubs, salons, retail, finance).
- The intent pair is the *reason*, so explainability is intrinsic.
- Technologies live in L3 keywords/L2 function — visible, searchable, but not gatekeeping.

## UI implications (P0)

- Profile/event setup: "Кого вы ищете" (chips, max 3) + "Что вы готовы предложить" (chips, max 3).
- Then industry + function (single select each), then optional keywords.
- Directory & recommendations show intent labels + reasons, plus keyword search.
- Event organizers can set default intents for their audience (e.g., "pitch night": seeking-investment/investing).

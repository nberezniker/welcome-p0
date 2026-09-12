# WELCOME — Canonical Tag Taxonomy v1 (draft for approval)

Problem: free-form tags almost never intersect literally (`pilot users` ≠ `ai-pilots`),
so explainable matching stays empty. Phase 1 fix: one canonical vocabulary for BOTH
sides (offers↔needs), chosen from a catalog — no free typing.

## Design rules

1. **One shared catalog.** A tag is a capability/resource/outcome that can be
   *offered* and/or *needed*. Matching stays `needs ∩ offers` on canonical ids.
2. **No free-form input.** Picker with search; unknown → "suggest a tag" queue.
3. **Aliases normalize at write time** (RU/EN/ES + common variants), so the frozen
   matching core never changes; parity tests keep passing.
4. **Existing tags are mapped, never silently dropped**: alias/fuzzy → canonical;
   unmapped stay flagged as `legacy` with an in-app prompt to re-pick.
5. Sides: `offer` | `need` | `both`. Domain is for UI grouping only.

## Domains & tags (v1)

### D1. AI & Data
| id | sides | EN | RU | aliases (examples) |
|---|---|---|---|---|
| ai-transformation | both | AI transformation | AI-трансформация | ai трансформация, ai adoption, внедрение ии |
| ai-automation | both | AI automation | AI-автоматизация | автоматизация процессов, workflow automation |
| applied-ai | both | Applied AI | прикладной AI | ai product, ai pilot delivery |
| ml-engineering | both | ML engineering | ML-инженерия | машинное обучение, ml |
| rag-systems | both | RAG / knowledge systems | RAG / базы знаний | rag, knowledge base, lightrag |
| data-platforms | both | Data platforms | дата-платформы | bi, analytics, dwh |
| mcp-integrations | both | MCP / agent tooling | MCP / агентные тулы | mcp, agents, tools |

### D2. Product & Design
| id | sides | EN | RU | aliases |
|---|---|---|---|---|
| product-discovery | both | Product discovery | продуктовый дискавери | discovery, custdev, customer development |
| product-design | both | Product design | продуктовый дизайн | ui/ux, дизайн продукта |
| ux-research | both | UX research | UX-исследования | ux, юзабилити, usability |
| design-systems | both | Design systems | дизайн-системы | ui kit, ds |
| qa-testing | both | QA & testing | QA и тестирование | qa, тестирование, autotests |

### D3. Engineering
| id | sides | EN | RU | aliases |
|---|---|---|---|---|
| frontend | both | Frontend | фронтенд | react, next.js, web ui |
| backend | both | Backend | бэкенд | api, server, node, python |
| fullstack | both | Full-stack | фуллстек | full stack |
| devops | both | DevOps / infra | DevOps / инфра | ci/cd, sre, инфраструктура, kubernetes |
| mobile | both | Mobile | мобильная разработка | ios, android, react native |

### D4. Growth & Sales
| id | sides | EN | RU | aliases |
|---|---|---|---|---|
| sales-leadership | both | Sales leadership | руководство продажами | head of sales, директор по продажам, cro |
| b2b-sales | both | B2B sales | B2B-продажи | корпоративные продажи, enterprise sales |
| b2b-clients | both | B2B clients | B2B-клиенты | клиенты b2b, корпоративные клиенты, customers |
| ecommerce | both | E-commerce | e-commerce | интернет-магазин, онлайн-продажи |
| marketing | both | Marketing | маркетинг | growth, перформанс, performance |
| community | both | Community | комьюнити | сообщество, community building |
| content | both | Content | контент | контент-маркетинг, seo |

### D5. Operations & Finance
| id | sides | EN | RU | aliases |
|---|---|---|---|---|
| process-design | both | Process design | проектирование процессов | bpm, регламенты, operations design |
| operations | both | Operations | операционка | ops, операционное управление |
| finance | both | Finance | финансы | cfo, финансовое моделирование, unit economics |
| legal | both | Legal | юристы | юридические услуги, contracts |
| hr-hiring | both | HR & hiring | HR и найм | найм, recruitment, подбор |

### D6. Capital & Resources
| id | sides | EN | RU | aliases |
|---|---|---|---|---|
| funding | need | Funding | финансирование | инвестиции, funding round, seed |
| investor-intros | need | Investor intros | знакомства с инвесторами | инвесторы, vc intros |
| grants | need | Grants | гранты | субсидии, грантовое финансирование |
| pilot-users | both | Pilot users | пилотные пользователи | пилоты, early adopters, pilot customers |
| feedback | both | Feedback | обратная связь | фидбек, product feedback |
| distribution | both | Distribution | дистрибуция | каналы продаж, партнёрские каналы |
| venue | offer | Venue | площадка | место проведения, офис |

### D7. Expertise & Network
| id | sides | EN | RU | aliases |
|---|---|---|---|---|
| mentoring | both | Mentoring | менторство | ментор, наставничество |
| advisory | both | Advisory | экспертный совет | консалтинг, advisory board |
| coaching | both | Coaching | коучинг | коуч |
| partnership | both | Partnership | партнёрство | партнёр, coop, сотрудничество |
| peer-network | both | Peer network | сеть контактов | нетворкинг, network |

## Phase 2 (later): semantic assist (additive)

- Free-text → canonical suggestion (embeddings/LLM) at input time, human confirms.
- Candidate expansion: when `needs ∩ offers` is empty, propose semantically close
  pairs as *suggestions* (never silently scoring them); explainable core unchanged.
- Never replace the deterministic `scorePair`; parity tests stay green.

## Migration plan (P0 implementation)

1. `src/domain/taxonomy.ts`: catalog (id, domain, sides, labels, aliases) + `normalizeTag()`.
2. Profile/membership validation: tags must be catalog ids (reject unknown with hint).
3. `/api/taxonomy` (public read) for the picker UI.
4. UI: tag picker with domain groups + search + "suggest a tag"; profile edit + membership override.
5. Data migration: map existing tags via aliases; unmapped → `legacy` + prompt.
6. Tests: normalization parity, catalog integrity (unique ids, valid sides, non-empty labels), picker API, migration mapping.

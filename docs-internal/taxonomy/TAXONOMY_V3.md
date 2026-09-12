# WELCOME — Networking Taxonomy v3 (three axes, all first-class)

v1 was a tech catalogue (wrong). v2 was intent-only (incomplete). Reality: people search
along THREE independent axes, and all three must be first-class, searchable and matchable.

| Axis | Question it answers | Match semantics | Example |
|---|---|---|---|
| **INTENT** (14 pairs) | "кого я ищу и кем полезен" | **complementary** (need↔offer) | «ищу со-фаундера» ↔ «готов быть со-фаундером» |
| **INTEREST** (~70) | "про что мне интересно" | **shared** (overlap) | оба: «AI», «стартапы» |
| **FUNCTION / INDUSTRY** | "кто я профессионально / где работаю" | **relevance** (overlap) | founder × CTO; retail × ecom |

Plus **KEYWORDS** (free text, ≤5) — nuance, search, and the input surface for phase-2
semantic assist. Never a gate.

---

## Axis 1 — INTENT (complementary pairs; max 3 need + 3 offer)

| Need (ищу) | Offer (готов) |
|---|---|
| seeking-cofounder | open-to-cofound |
| hiring | open-to-work |
| seeking-clients | offering-services |
| seeking-partner | open-to-partner |
| seeking-investment | investing |
| seeking-mentor | mentoring |
| seeking-expertise | advising |
| seeking-pilot-users | pilot-ready |
| seeking-distribution | distribution-ready |
| seeking-team | open-to-project |
| seeking-community | community-host |
| seeking-vendor | offering-vendor-services |
| seeking-venue | offering-venue |
| seeking-feedback | offering-feedback |
| seeking-supplier | supplying-services (added) |
| seeking-cofounder-for-fund | investing-in-funds (added, investor↔fund) |

## Axis 2 — INTEREST catalogue (shared; up to 5 picks, catalog-only)

**Tech & Digital:** ai-ml · saas · dev-tools · automation · data-analytics ·
cybersecurity · web3-crypto · ar-vr · robotics-hardware · no-code

**Startups & Business:** startups · fundraising · venture-capital · bootstrapping ·
marketplaces · entrepreneurship · franchising · family-business · exits-ma · small-business

**Marketing & Growth:** performance-marketing · brand · content-seo · social-media ·
pr-comms · community-building · influencer-marketing · crm-email

**Sales & BD:** b2b-sales · partnerships · distribution-channels · customer-success ·
negotiation · enterprise-sales

**Product & Design:** product-management · ux-ui · design-systems · user-research ·
prototyping · accessibility

**Finance & Investment:** personal-finance · corporate-finance · angel-investing ·
fintech · insurance · taxes-legal · real-estate-investing

**People & Leadership:** hiring · team-building · leadership · remote-work · hr-culture ·
coaching

**Health & Wellness:** fitness · nutrition · mental-health · longevity · healthtech · wellness

**Beauty & Fashion:** beauty-industry · skincare · fashion · cosmetics-retail · salon-business

**Education & Science:** edtech · learning · academia-research · languages · science-tech

**Sustainability & Impact:** climate · circular-economy · social-impact · esg · energy

**Lifestyle & Culture:** travel · food-restaurants · sports · art-design · music ·
books-media · gaming · photography

**Local & Community:** barcelona-local · spain-business · expat-life · local-community ·
latam-connect

**Industry ties:** retail-ecommerce · logistics · manufacturing · public-sector ·
legal-services · construction · tourism-horeca

## Axis 3 — FUNCTION + INDUSTRY (single select each)

**Function:** founder-ceo · c-level-other · product · design · engineering · data-ai ·
marketing · sales-bd · finance · operations · hr-people · legal · investor · student

**Industry:** ai-saas · fintech · ecommerce-retail · education · health-beauty ·
real-estate · logistics · media-content · manufacturing · public-sector · horeca-tourism · other

---

## Matching model (deterministic + explainable; frozen core untouched)

```
intentScore  = 1 if ∃ (a.need ∩ complement(b.offer)) or vice versa, else 0     # gate
interestOverlap = |a∩b| / min(|a|,|b|)                                          # 0..1
functionMatch = 1 if same function or complementary (founder↔cto, sales↔marketing)
industryMatch = 1 if same industry
score = round(100 * (0.45*intentScore + 0.35*interestOverlap + 0.12*functionMatch + 0.08*industryMatch))
```

**Visibility gate (prevents noise):** show a pair only if `intentScore=1`
OR `interestOverlap ≥ 0.34` OR (`functionMatch=1` AND `industryMatch=1`).
`scorePair` (the frozen tag/keyword core) remains as the keyword booster/tiebreak —
parity tests stay green; this layer is additive.

**Human reasons (always answerable):**
- intent: «Ищет со-фаундера — вы открыты к со-фундерству»
- interest: «Общие интересы: AI, стартапы, маркетинг»
- context: «Оба founder · ai-saas»

## Search/UX implications (P0)

Directory & recommendations get three explicit modes:
1. **«Ищут то же, что могу я»** — intent-first (default)
2. **«Люди по интересам»** — interest-first (chips + search)
3. **«Все»** — with facet filters (interest, function, industry, language)

Profile/event setup: intents (max 3+3) → interests (max 5) → function/industry →
languages → optional keywords. Organizers set event default interests (e.g., AI meetup).

## Privacy notes

Interests are chosen from a curated catalogue (no free-form sensitive inference);
`prefer-not-to-say` allowed for function/industry; interests never leak beyond the
event/directory scope a user opted into; keywords are user-authored text.

## Why v3

- Interests are searched as often as roles → interest-only matches are legitimate
  (that is "нетворкинг по интересам") and must not be hidden behind the intent gate.
- Three orthogonal axes keep reasons crisp and the model explainable.
- Non-technical audiences are fully served (beauty, health, retail, community).

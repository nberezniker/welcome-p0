# Current research — market, AutoClaw and integrations
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

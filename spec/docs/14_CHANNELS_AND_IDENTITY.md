# Telegram, WhatsApp and LinkedIn — exact product boundaries

## Telegram — P0
Use Telegram Bot API webhook over HTTPS. Configure webhook secret token and validate the header. Persist/dedupe `update_id` or provider event id.

Binding flow:
1. Authenticated WELCOME user asks to connect Telegram.
2. Server creates random purpose-bound one-time challenge (hash stored, TTL ~10 min).
3. Browser opens `https://t.me/<bot>?start=<opaque>`.
4. User presses Start / sends `/start`; bot receives the token.
5. Server atomically consumes challenge and binds Telegram user id to the same account.

The deep-link token is not an account bearer token, not contact-sharing consent and not reusable. Never put email/profile UUID/private data in the `start` value.

Commands P0: `/start`, `/profile`, `/qr`, `/events`, `/need`, `/matches`, `/connections`, `/privacy`, `/stop`, `/delete`, `/help`. Every command checks account binding and current purpose/visibility.

## WhatsApp — optional P1
Two distinct features:
1. **User-provided public WhatsApp contact link** — just a link/field on the personal card, controlled by user visibility.
2. **WELCOME automated messaging** — WhatsApp Business Platform integration with business account/number, templates, webhooks, opt-in and current pricing/policy.

AutoClaw being controllable through a user's WhatsApp does not prove #2. A `wa.me` link does not prove #2. No competition screenshot should imply otherwise.

## LinkedIn — optional P1
Official OIDC scopes can authenticate and retrieve lite profile data. WELCOME may use this as an optional sign-in/import helper, but:
- do not claim employment/company/history enrichment;
- do not scrape LinkedIn or import browser cookies;
- display what was imported and let the user confirm/edit professional fields;
- LinkedIn profile URL may be user-supplied/validated as a link without server-side fetch.

## Channel abstraction
Use a small interface inspired by `neko_bot/src/channels/adapter.js`: parse inbound → normalized event; send message → provider result. Do not copy Instagram-specific fields or assumptions. Provider adapters must return `sent | delivered | failed | unknown | suppressed` only when evidence supports the state.

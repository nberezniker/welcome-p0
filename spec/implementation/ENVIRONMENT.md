# Environment variables — names only
Never commit values.

## Core
`APP_ENV`, `APP_BASE_URL`, `DATABASE_URL`, `AUTH_BASE_URL`/provider-specific auth vars, `ENCRYPTION_KEY` or managed KMS reference, `HASH_PEPPER`, `LOG_LEVEL`.

## Telegram P0
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`.

## Luma optional
`LUMA_API_KEY`, `LUMA_WEBHOOK_SECRET` only if the current official webhook contract actually uses/defines one; do not invent verification fields.

## WhatsApp optional
`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` as required by current Meta setup.

## LinkedIn optional
`LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`.

## Release/observability
Hosting provider vars supplied by its secret store; `SENTRY_DSN` or equivalent only if privacy configuration is reviewed. No `NEXT_PUBLIC_` secret.

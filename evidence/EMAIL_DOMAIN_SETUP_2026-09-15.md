# Email domain for production sending — setup record (2026-09-15)

## Goal
Make OTP / service emails reach **arbitrary recipients** (not only the account
owner). Until this was done, every non-allowlisted address failed honestly with
`503 email_send_failed`, because no sending domain was verified at the provider.

## What was set up
- Site domain: `welcome.colmogravity.net` (Vercel custom domain, verified, TLS issued).
- Sending domain: `send.colmogravity.net` (Resend, region us-east-1, verified).
- `APP_BASE_URL=https://welcome.colmogravity.net`
- `RESEND_FROM=WELCOME <no-reply@send.colmogravity.net>`

## DNS records (zone colmogravity.net, Cloudflare)
| Type | Name | Value | Notes |
|---|---|---|---|
| TXT | `_vercel` | `vc-domain-verify=welcome.colmogravity.net,e57d…` | Vercel ownership |
| CNAME | `welcome` | `cname.vercel-dns.com` | DNS only (not proxied) |
| TXT | `resend._domainkey.send` | `p=MIGf…IDAQAB` | DKIM |
| MX | `send.send` | `feedback-smtp.us-east-1.amazonses.com` (prio 10) | |
| TXT | `send.send` | `v=spf1 include:amazonses.com ~all` | SPF |
| CNAME | `rsend.send` | `send.forge.rmta.net` | **DNS only** |

## Findings worth keeping
1. **`rsend.send` is a CNAME, not a TXT.** The first attempt created it as TXT
   (wrong note in the internal checklist) — a TXT there can never verify.
   The provider's own record list is authoritative: `record` = purpose label
   (DKIM/SPF), `type` = actual DNS type (TXT/MX/CNAME). Do not confuse them.
2. **A stuck `pending` domain is fixed by re-creating it.** After the records
   were all correct in DNS (confirmed against three public resolvers + the
   authoritative Cloudflare NS via DoH), the provider still reported
   `pending`. Deleting and re-adding the domain via API and re-running
   verification cleared it; all four records went `verified` within ~4 minutes.
3. Unverified sending domain → `403 The <domain> domain is not verified` →
   the OTP route correctly maps this to `503 email_send_failed` (honest, retryable).

## Evidence
- `GET /domains` → `status: verified`, records `TXT:verified, MX:verified, TXT:verified, CNAME:verified`
- Direct API send from the new domain → `202` + message id
- `POST /api/auth/otp/request {"email":"qa-probe@colmogravity.net"}` → `HTTP 200 {"ok":true}`
  (the route returns 200 only when the provider accepted the message)
- Owner control still exempt (`devCode` in response, ADR 0009 allowlist)

## Secrets hygiene
- The temporary Resend ops key created for this fix was **deleted** right after use.
- The Cloudflare token used for the DNS writes is named "Edit zone DNS"
  (zone colmogravity.net) and remains in the account; revoke it when no longer needed.

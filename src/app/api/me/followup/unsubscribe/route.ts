import { NextRequest } from 'next/server';
import { POLICY_VERSION, resolveLocale, t } from '../../../../../i18n';
import { recordConsent, suppressJobsForConsent } from '../../../../../domain/consent';
import { verifyUnsubscribeToken, type FollowupMechanic } from '../../../../../domain/followup';
import { setOptIn } from '../../../../../infra/followup-preferences';
import { suppressJobsForAccountKinds } from '../../../../../infra/outbox';
import { getSql } from '../../../../../lib/db';
import { requireHashPepper } from '../../../../../lib/env';
import { log } from '../../../../../lib/logger';
import { withApi } from '../../../../../lib/http';

/**
 * GET /api/me/followup/unsubscribe?t=<token> — one-click stop for a reminder or
 * a digest, straight from the message (Phase 4, §B5).
 *
 * WHY a GET without a session: the link has to work from a mailbox, on a device
 * that has never signed in. It carries an HMAC over (mechanic, account id) —
 * unforgeable without HASH_PEPPER, carrying no address and no session — and the
 * only thing it can do is REMOVE a permission. That is also why this route is
 * deliberately NOT rate-limited: a stop link must never be blocked, and with a
 * 128-bit HMAC there is nothing to guess.
 *
 * Two properties are load-bearing:
 *
 *   - it works even while the mechanic's flag is OFF. An old message's link must
 *     keep working after an operator switches a mechanic off, and a route that
 *     can only revoke can never send anything.
 *   - it goes down the SAME path as the in-app toggle: opt-in timestamp pair, the
 *     `digest_weekly` consent withdrawal for the digest, and the suppression of
 *     anything already queued. The message therefore stops, not just the next
 *     one — and "consent revoked between enqueue and send" is answered by the
 *     existing suppression hook, not by a new mechanism.
 *
 * The response is a small self-contained HTML page: the recipient is not signed
 * in, so there is no app shell to render into, and returning JSON to a browser
 * click would be an unreadable dead end. An invalid token answers the same
 * generic page as a valid one for an unknown account — the endpoint must not
 * become an oracle for which accounts exist.
 */

function html(locale: string, status: number, body: string): Response {
  return new Response(body.replace('{lang}', locale), {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function page(title: string, heading: string, paragraph: string, hint: string | null): string {
  return `<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>
body{margin:0;padding:2.5rem 1.25rem;background:#f7f6f3;color:#14130f;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:34rem;margin:0 auto;background:#fff;border:1px solid #e3e0d8;border-radius:1rem;padding:1.75rem}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0 0 .75rem}
.hint{color:#6b6a63;font-size:.85rem}
</style>
</head>
<body>
<main>
<h1>${heading}</h1>
<p>${paragraph}</p>
${hint ? `<p class="hint">${hint}</p>` : ''}
</main>
</body>
</html>
`;
}

async function getRoute(req: NextRequest) {
  const locale = resolveLocale(req.nextUrl.searchParams.get('lang'));
  const title = t(locale, 'followup.unsubscribe.title');

  try {
    const payload = verifyUnsubscribeToken(req.nextUrl.searchParams.get('t'), requireHashPepper());
    if (!payload) {
      return html(
        locale,
        400,
        page(
          title,
          t(locale, 'followup.unsubscribe.linkInvalid'),
          t(locale, 'followup.unsubscribe.linkInvalidHint'),
          t(locale, 'followup.unsubscribe.noAccountHint'),
        ),
      );
    }

    await stopMechanic(payload.accountId, payload.mechanic);

    const done = payload.mechanic === 'digest' ? 'followup.unsubscribe.doneDigest' : 'followup.unsubscribe.doneReminders';
    return html(
      locale,
      200,
      page(title, t(locale, 'followup.unsubscribe.doneTitle'), t(locale, done), t(locale, 'followup.unsubscribe.keptHint')),
    );
  } catch (err) {
    // A failure must still be a page: the recipient clicked a link, not an API.
    // The token from that link is deliberately NOT part of the line — it is a
    // bearer value, and it is exactly what a debug-by-log reflex would add.
    log.error('[followup-unsubscribe] failed', { event: 'followup_unsubscribe_failed', err });
    return html(locale, 500, page(title, t(locale, 'followup.unsubscribe.failed'), t(locale, 'followup.unsubscribe.failedHint'), null));
  }
}

/**
 * Revokes one mechanic for an account: opt-in off, consent withdrawn (digest),
 * everything still queued suppressed. One transaction, so a crash cannot leave
 * "opted out but the digest still pending".
 */
async function stopMechanic(accountId: string, mechanic: FollowupMechanic): Promise<void> {
  const sql = getSql();
  await sql.begin(async (tx) => {
    await setOptIn(tx, accountId, mechanic, false);
    if (mechanic === 'digest') {
      await recordConsent(tx, accountId, {
        purpose: 'digest_weekly',
        action: 'withdraw',
        scopeType: 'global',
        scopeId: null,
        fieldSet: [],
        policyVersion: POLICY_VERSION,
      });
      await suppressJobsForConsent(tx, accountId, 'digest_weekly', { scopeType: 'global' });
    } else {
      await suppressJobsForAccountKinds(tx, accountId, ['followup_reminder'], 'unsubscribed');
    }
  });
}

export const GET = withApi(getRoute);

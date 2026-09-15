import { NextRequest } from 'next/server';
import { POLICY_VERSION } from '../../../../i18n';
import { hasGrant, recordConsent, suppressJobsForConsent } from '../../../../domain/consent';
import type { FollowupMechanic } from '../../../../domain/followup';import { loadOptInState, setOptIn } from '../../../../infra/followup-preferences';
import { suppressJobsForAccountKinds } from '../../../../infra/outbox';
import { requireAccount } from '../../../../lib/auth';
import { getSql } from '../../../../lib/db';
import { digestEnabled, followupRemindersEnabled } from '../../../../lib/env';
import { internalError, jsonError, jsonOk, privateCacheHeaders, readJsonBody, withApi } from '../../../../lib/http';

/**
 * GET/POST /api/me/followup — the opt-in switch for the two Phase-4 mechanics
 * (docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md §B5).
 *
 * The endpoint DOES NOT EXIST while the mechanic's flag is off: both verbs answer
 * `404 feature_disabled`, so an instance that never turned the feature on has no
 * opt-in surface at all — not a hidden one, and not one that silently writes
 * preferences nothing will ever read.
 *
 * What the POST writes, in ONE transaction, is the whole decision:
 *
 *   1. the opt-in timestamp pair (followup_preferences) — explicit, timestamped,
 *      revocable, audited (followup.opt_in / followup.opt_out);
 *   2. for the DIGEST, the `digest_weekly` consent event as well: the digest is a
 *      consent purpose of its own, and its one-click unsubscribe revokes exactly
 *      that purpose. Grant and revoke are written here together with the opt-in
 *      so the two halves cannot drift apart through this surface;
 *   3. on opt-OUT, the suppression of what is already queued — the consent path
 *      for the digest, and a kind-scoped cancellation for the reminders. A stop
 *      that only affects the future is not a stop.
 *
 * The REMINDER opt-in deliberately does NOT grant `service_channel`. A narrow
 * «remind me about my next step» switch must not also unlock introduction
 * notices, so when that consent is missing the response says so
 * (`service_channel_consent: false`) and the UI offers the privacy page instead
 * of a switch that would do nothing.
 */

const MECHANICS: readonly FollowupMechanic[] = ['reminders', 'digest'];

function mechanicEnabled(mechanic: FollowupMechanic): boolean {
  return mechanic === 'reminders' ? followupRemindersEnabled() : digestEnabled();
}

export async function getRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const enabled = { reminders: followupRemindersEnabled(), digest: digestEnabled() };
    if (!enabled.reminders && !enabled.digest) {
      return jsonError(404, 'feature_disabled', 'Follow-up messages are not available on this instance');
    }

    const sql = getSql();
    const [state, serviceChannel] = await Promise.all([
      loadOptInState(sql, auth.accountId),
      hasGrant(sql, auth.accountId, 'service_channel'),
    ]);

    return jsonOk(
      {
        ok: true,
        enabled,
        opted_in: { reminders: state.reminders, digest: state.digest },
        consent: { service_channel: serviceChannel, digest_weekly: await hasGrant(sql, auth.accountId, 'digest_weekly') },
      },
      { headers: privateCacheHeaders() },
    );
  } catch (err) {
    return internalError(err);
  }
}

interface FollowupToggleInput {
  mechanic: FollowupMechanic;
  optedIn: boolean;
}

function validateToggleInput(body: unknown): { ok: true; value: FollowupToggleInput } | { ok: false; code: string; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.mechanic !== 'string' || !(MECHANICS as readonly string[]).includes(b.mechanic)) {
    return { ok: false, code: 'invalid_mechanic', message: `mechanic must be one of: ${MECHANICS.join(', ')}` };
  }
  if (typeof b.opted_in !== 'boolean') {
    return { ok: false, code: 'invalid_opted_in', message: 'opted_in must be a boolean' };
  }
  return { ok: true, value: { mechanic: b.mechanic as FollowupMechanic, optedIn: b.opted_in } };
}

export async function postRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const input = validateToggleInput(await readJsonBody(req));
    if (!input.ok) return jsonError(400, input.code, input.message);

    const { mechanic, optedIn } = input.value;
    if (!mechanicEnabled(mechanic)) {
      return jsonError(404, 'feature_disabled', 'This follow-up message is not available on this instance');
    }

    const sql = getSql();
    await sql.begin(async (tx) => {
      await setOptIn(tx, auth.accountId, mechanic, optedIn);
      if (mechanic === 'digest') {
        await recordConsent(tx, auth.accountId, {
          purpose: 'digest_weekly',
          action: optedIn ? 'grant' : 'withdraw',
          scopeType: 'global',
          scopeId: null,
          fieldSet: [],
          policyVersion: POLICY_VERSION,
        });
        if (!optedIn) {
          // Withdrawal suppresses every queued digest for this account through
          // the existing consent hook (and records the suppression attempt).
          await suppressJobsForConsent(tx, auth.accountId, 'digest_weekly', { scopeType: 'global' });
        }
      } else if (!optedIn) {
        // Kind-scoped: reminders share `service_channel` with the introduction
        // notices, and stopping reminders must not silence those.
        await suppressJobsForAccountKinds(tx, auth.accountId, ['followup_reminder'], 'opted_out');
      }
    });

    const state = await loadOptInState(sql, auth.accountId);
    return jsonOk({ ok: true, mechanic, opted_in: state[mechanic] });
  } catch (err) {
    return internalError(err);
  }
}

export const GET = withApi(getRoute);
export const POST = withApi(postRoute);

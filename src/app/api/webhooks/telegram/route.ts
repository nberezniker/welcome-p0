import { NextRequest } from 'next/server';
import type { Sql } from 'postgres';
import { getSql } from '../../../../lib/db';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../lib/http';
import { secureSecretEqual } from '../../../../lib/crypto';
import { validateTelegramUpdate } from '../../../../integrations/telegram/updates';
import { enqueueOutbox } from '../../../../infra/outbox';

/**
 * POST /api/webhooks/telegram — durable accept point for Bot API updates.
 *
 * Order of operations (spec 04 §7):
 *   1. AC-36: the x-telegram-bot-api-secret-token header must equal
 *      TELEGRAM_WEBHOOK_SECRET (constant-time) — checked BEFORE any parsing,
 *      DB access or processing. Wrong/missing secret → 401, zero side effects.
 *   2. Validate the update shape (hand-rolled; 400 on garbage).
 *   3. Insert into inbox_events with UNIQUE(provider, external_event_id):
 *      a replayed update_id hits the unique index → 200 OK, NO business
 *      action (AC-37).
 *   4. Enqueue one outbox job (kind 'telegram_update') in the same
 *      transaction — durable accept now, async processing later; the webhook
 *      responds 200 immediately.
 */

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

async function postRoute(req: NextRequest) {
  try {
    // 1. Secret gate BEFORE anything else (AC-36).
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    const provided = req.headers.get(SECRET_HEADER) ?? '';
    if (!expected || !secureSecretEqual(provided, expected)) {
      return jsonError(401, 'unauthorized_webhook', 'Invalid webhook secret');
    }

    // 2. Shape validation.
    const body = await readJsonBody(req);
    const parsed = validateTelegramUpdate(body);
    if (!parsed.ok) return jsonError(400, parsed.code, parsed.message);

    // 3+4. Durable accept + outbox enqueue, deduped by update_id.
    const sql: Sql = getSql();
    const updateIdStr = String(parsed.value.updateId);
    const accepted = await sql.begin(async (tx) => {
      const inserted = await tx<{ id: number }[]>`
        INSERT INTO inbox_events (provider, external_event_id, event_type, minimal_payload)
        VALUES ('telegram', ${updateIdStr}, ${parsed.value.eventType}, ${tx.json(parsed.value.minimalPayload)})
        ON CONFLICT (provider, external_event_id) DO NOTHING
        RETURNING id
      `;
      if (!inserted[0]) return false; // replay: one business operation only (AC-37)
      if (parsed.value.eventType === 'message') {
        // subject_id is uuid-typed (business subjects); the inbox event id is a
        // bigserial, so it travels in the payload instead.
        await enqueueOutbox(tx, {
          dedupeKey: `tg_update:${updateIdStr}`,
          kind: 'telegram_update',
          subjectId: null,
          channel: 'telegram',
          purpose: 'service_channel',
          payload: { ...parsed.value.minimalPayload, inbox_event_id: inserted[0].id },
        });
      }
      return true;
    });

    // Replays get the same 200 — the provider must not retry on dedupe.
    return jsonOk({ ok: true, accepted });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

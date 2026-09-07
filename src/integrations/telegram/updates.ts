/**
 * Hand-rolled validator for Telegram Bot API `update` objects (no new deps).
 * Only the fields WELCOME needs are extracted; everything else is ignored.
 * A language choice, page view, link click or /start parameter is NEVER
 * consent — this module only validates transport shapes.
 */

export interface ParsedTelegramUpdate {
  updateId: number;
  eventType: 'message' | 'non_message';
  /** Minimal redacted payload persisted in inbox_events. */
  minimalPayload: {
    update_id: number;
    chat_id?: number;
    from_id?: number;
    text?: string;
    message_id?: number;
  };
}

export type Parsed =
  | { ok: true; value: ParsedTelegramUpdate }
  | { ok: false; code: string; message: string };

const UPDATE_TEXT_MAX = 4096; // Telegram message hard limit

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

export function validateTelegramUpdate(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_update', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;

  if (!isInt(b['update_id'])) {
    return { ok: false, code: 'invalid_update_id', message: 'update_id must be a non-negative integer' };
  }
  const updateId = b['update_id'];

  const message = b['message'];
  if (message === undefined) {
    // Valid Telegram update of another kind (callback_query, edited_message, …):
    // durably accepted with a minimal payload, no business processing in P0.
    return {
      ok: true,
      value: { updateId, eventType: 'non_message', minimalPayload: { update_id: updateId } },
    };
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { ok: false, code: 'invalid_message', message: 'message must be an object when present' };
  }
  const m = message as Record<string, unknown>;

  if (!isInt(m['message_id'])) {
    return { ok: false, code: 'invalid_message_id', message: 'message.message_id must be a non-negative integer' };
  }
  const messageId: number = m['message_id'];
  const chat = m['chat'];
  if (typeof chat !== 'object' || chat === null || Array.isArray(chat) || !isInt((chat as Record<string, unknown>)['id'])) {
    return { ok: false, code: 'invalid_chat', message: 'message.chat.id must be a non-negative integer' };
  }
  const chatId: number = (chat as { id: number })['id'];

  let fromId: number | undefined;
  const from = m['from'];
  if (from !== undefined) {
    if (typeof from !== 'object' || from === null || Array.isArray(from) || !isInt((from as Record<string, unknown>)['id'])) {
      return { ok: false, code: 'invalid_from', message: 'message.from.id must be a non-negative integer when present' };
    }
    fromId = (from as { id: number })['id'];
  }

  let text: string | undefined;
  if (m['text'] !== undefined) {
    if (typeof m['text'] !== 'string' || m['text'].length > UPDATE_TEXT_MAX) {
      return { ok: false, code: 'invalid_text', message: `message.text must be a string up to ${UPDATE_TEXT_MAX} chars` };
    }
    text = m['text'];
  }

  return {
    ok: true,
    value: {
      updateId,
      eventType: 'message',
      minimalPayload: {
        update_id: updateId,
        chat_id: chatId,
        ...(fromId !== undefined ? { from_id: fromId } : {}),
        ...(text !== undefined ? { text } : {}),
        message_id: messageId,
      },
    },
  };
}

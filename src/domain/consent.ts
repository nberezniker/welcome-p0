import type { Sql, TransactionSql } from 'postgres';
import { recordAudit } from '../lib/audit';
import { suppressJobsForAccountPurpose } from '../infra/outbox';
import type { Validated } from '../domain/profile';

/** Consent registry: purpose-scoped, append-only. A language choice, page view,
 * link click, imported registration or /start parameter is NEVER consent.
 * Latest record per exact (purpose, scope_type, scope_id) wins. */

export const CONSENT_PURPOSES = [
  'public_card',
  'event_directory',
  'introduction_fields',
  'service_channel',
  'organizer_marketing',
  'product_marketing',
] as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_SCOPE_TYPES = ['global', 'event'] as const;
export type ConsentScopeType = (typeof CONSENT_SCOPE_TYPES)[number];

export function isConsentPurpose(value: unknown): value is ConsentPurpose {
  return typeof value === 'string' && (CONSENT_PURPOSES as readonly string[]).includes(value);
}

export function isConsentScopeType(value: unknown): value is ConsentScopeType {
  return typeof value === 'string' && (CONSENT_SCOPE_TYPES as readonly string[]).includes(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLICY_VERSION_MAX = 50;
const FIELD_SET_MAX_ITEMS = 30;
const FIELD_NAME_MAX = 80;

export interface ConsentInput {
  purpose: ConsentPurpose;
  action: 'grant' | 'withdraw';
  scopeType: ConsentScopeType;
  scopeId: string | null;
  fieldSet: string[];
  policyVersion: string;
}

/** Validates a consent record body. Actor is always the authenticated account —
 * never taken from the body. */
export function validateConsentInput(body: unknown): Validated<ConsentInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, code: 'invalid_body', message: 'JSON object expected' };
  }
  const b = body as Record<string, unknown>;

  const action = b.action;
  if (action !== 'grant' && action !== 'withdraw') {
    return { ok: false, code: 'invalid_action', message: 'action must be "grant" or "withdraw"' };
  }

  if (!isConsentPurpose(b.purpose)) {
    return { ok: false, code: 'invalid_purpose', message: `purpose must be one of: ${CONSENT_PURPOSES.join(', ')}` };
  }

  if (!isConsentScopeType(b.scope_type)) {
    return { ok: false, code: 'invalid_scope', message: 'scope_type must be "global" or "event"' };
  }

  let scopeId: string | null = null;
  if (b.scope_type === 'event') {
    if (typeof b.scope_id !== 'string' || !UUID_RE.test(b.scope_id)) {
      return { ok: false, code: 'invalid_scope_id', message: 'event scope requires a valid scope_id (event uuid)' };
    }
    scopeId = b.scope_id;
  } else if (b.scope_id !== undefined && b.scope_id !== null) {
    return { ok: false, code: 'invalid_scope_id', message: 'global scope must not carry a scope_id' };
  }

  const policyVersion = typeof b.policy_version === 'string' ? b.policy_version.trim() : '';
  if (policyVersion.length < 1 || policyVersion.length > POLICY_VERSION_MAX) {
    return { ok: false, code: 'invalid_policy_version', message: `policy_version is required (1..${POLICY_VERSION_MAX} chars)` };
  }

  let fieldSet: string[] = [];
  if (b.field_set !== undefined && b.field_set !== null) {
    if (!Array.isArray(b.field_set) || b.field_set.length > FIELD_SET_MAX_ITEMS) {
      return { ok: false, code: 'invalid_field_set', message: `field_set must be an array of at most ${FIELD_SET_MAX_ITEMS} strings` };
    }
    for (const item of b.field_set) {
      if (typeof item !== 'string' || item.trim().length < 1 || item.trim().length > FIELD_NAME_MAX) {
        return { ok: false, code: 'invalid_field_set', message: `field_set items must be non-empty strings up to ${FIELD_NAME_MAX} chars` };
      }
    }
    fieldSet = [...new Set((b.field_set as string[]).map((x) => x.trim()))];
  }

  return {
    ok: true,
    value: { purpose: b.purpose, action, scopeType: b.scope_type, scopeId, fieldSet, policyVersion },
  };
}

export interface ConsentScopeRef {
  scopeType: ConsentScopeType;
  scopeId?: string | null;
}

/** Appends a consent record. Append-only: history is never rewritten. */
export async function recordConsent(
  sql: Sql | TransactionSql,
  accountId: string,
  input: ConsentInput,
): Promise<void> {
  await sql`
    INSERT INTO consent_events (account_id, purpose, scope_type, scope_id, field_set, policy_version, action)
    VALUES (${accountId}, ${input.purpose}, ${input.scopeType}, ${input.scopeId}, ${input.fieldSet}, ${input.policyVersion}, ${input.action})
  `;
}

/**
 * Evaluates the CURRENT grant state for an exact (purpose, scope_type, scope_id):
 * the latest record's action wins. An event-scoped grant never implies global.
 */
export async function hasGrant(
  sql: Sql | TransactionSql,
  accountId: string,
  purpose: ConsentPurpose,
  scope: ConsentScopeRef = { scopeType: 'global' },
): Promise<boolean> {
  const scopeId = scope.scopeId ?? null;
  const rows = await sql<{ action: string }[]>`
    SELECT action
    FROM consent_events
    WHERE account_id = ${accountId}
      AND purpose = ${purpose}
      AND scope_type = ${scope.scopeType}
      AND ((${scopeId}::text IS NULL AND scope_id IS NULL) OR scope_id = ${scopeId}::text)
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0]?.action === 'grant';
}

/**
 * Consent-withdrawal hook (AC-25): every outbox job for this account+purpose
 * that has NOT yet been handed to a transport is suppressed inside the
 * withdrawal transaction. Jobs already sent stay untouched — delivered
 * messages are never retroactively "unsent". The suppression itself is
 * audited; jobs suppressed at send time additionally carry their own
 * delivery_attempts row with the reason code.
 */
export async function suppressJobsForConsent(
  sql: Sql | TransactionSql,
  accountId: string,
  purpose: ConsentPurpose,
  scope: ConsentScopeRef,
  actorNote: Record<string, unknown> = {},
): Promise<void> {
  const suppressedIds = await suppressJobsForAccountPurpose(sql, accountId, purpose);
  await recordAudit(sql, accountId, 'consent.suppress_requested', 'account', accountId, {
    purpose,
    scope_type: scope.scopeType,
    scope_id: scope.scopeId ?? null,
    suppressed_job_count: suppressedIds.length,
    ...actorNote,
  });
}

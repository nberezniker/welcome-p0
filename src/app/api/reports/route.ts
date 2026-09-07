import { NextRequest } from 'next/server';
import { getSql } from '../../../lib/db';
import { requireAccount } from '../../../lib/auth';
import { jsonError, jsonOk, readJsonBody, asString, internalError } from '../../../lib/http';
import { recordAudit } from '../../../lib/audit';

/** POST /api/reports — report another account. Stored for operator review;
 * reports never trigger automated messages and are invisible to the target. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['spam', 'harassment', 'inappropriate', 'other'] as const;
const DETAILS_MAX = 1000;

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = await readJsonBody(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

    const target = b.target_account_id;
    if (typeof target !== 'string' || !UUID_RE.test(target)) {
      return jsonError(400, 'invalid_target', 'target_account_id must be an account uuid');
    }
    if (target === auth.accountId) {
      return jsonError(400, 'self_report', 'You cannot report yourself');
    }
    if (typeof b.reason !== 'string' || !(REASONS as readonly string[]).includes(b.reason)) {
      return jsonError(400, 'invalid_reason', `reason must be one of: ${REASONS.join(', ')}`);
    }
    const details = asString(b.details, { maxLength: DETAILS_MAX, minLength: 1 }) ?? (b.details === undefined ? null : '');
    if (details === '') return jsonError(400, 'invalid_details', `details must be up to ${DETAILS_MAX} chars`);

    const sql = getSql();
    const exists = await sql<{ id: string }[]>`SELECT id FROM accounts WHERE id = ${target} LIMIT 1`;
    if (!exists[0]) return jsonError(404, 'not_found', 'Account not found');

    const inserted = await sql<{ id: string; status: string }[]>`
      INSERT INTO reports (reporter_account_id, target_account_id, reason, details)
      VALUES (${auth.accountId}, ${target}, ${b.reason}, ${details})
      RETURNING id, status
    `;

    await recordAudit(sql, auth.accountId, 'report.created', 'account', target, {
      report_id: inserted[0]?.id,
      reason: b.reason,
    });

    return jsonOk({ ok: true, report: { id: inserted[0]?.id, status: inserted[0]?.status } }, { status: 201 });
  } catch (err) {
    return internalError(err);
  }
}

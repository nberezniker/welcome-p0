import { NextRequest, NextResponse } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { jsonError, internalError } from '../../../../lib/http';
import { requireEncryptionKey } from '../../../../lib/env';
import { decryptValue } from '../../../../lib/crypto';
import { POLICY_VERSION } from '../../../../i18n';

/**
 * POST /api/me/export — machine-readable JSON export of the caller's data
 * (profile, contacts decrypted, consents, memberships, notes, blocks, reports).
 * Named by the Phase-4 brief; kept minimal. Listed as a new endpoint in the
 * phase report.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const sql = getSql();
    const key = requireEncryptionKey();

    const [profileRows, contactRows, consentRows, membershipRows, noteRows, blockRows, reportRows] = await Promise.all([
      sql`SELECT public_slug, display_name, headline, company, short_bio, languages, offer_tags, need_tags, revision, created_at
          FROM profiles WHERE account_id = ${auth.accountId}`,
      sql<{ kind: string; encrypted_value: string; public_enabled: boolean; updated_at: Date }[]>`
        SELECT cf.kind, cf.encrypted_value, cf.public_enabled, cf.updated_at
        FROM contact_fields cf JOIN profiles p ON p.id = cf.profile_id
        WHERE p.account_id = ${auth.accountId}`,
      sql`SELECT purpose, scope_type, scope_id, field_set, policy_version, action, created_at
          FROM consent_events WHERE account_id = ${auth.accountId} ORDER BY created_at ASC`,
      sql`SELECT e.id AS event_id, e.name AS event_name, m.state, m.directory_visible, m.matching_enabled,
                 m.offer_tags, m.need_tags, m.attendance_source, m.created_at
          FROM event_memberships m JOIN events e ON e.id = m.event_id
          JOIN profiles p ON p.id = m.profile_id
          WHERE p.account_id = ${auth.accountId}`,
      sql`SELECT other_profile_id, note_text, next_step, next_step_status, updated_at
          FROM connection_notes WHERE owner_account_id = ${auth.accountId}`,
      sql`SELECT target_account_id, created_at FROM blocks WHERE blocker_account_id = ${auth.accountId}`,
      sql`SELECT target_account_id, reason, details, status, created_at FROM reports WHERE reporter_account_id = ${auth.accountId}`,
    ]);

    const contacts = contactRows.map((c) => ({
      kind: c.kind,
      value: (() => {
        try {
          return decryptValue(c.encrypted_value, key);
        } catch {
          return '';
        }
      })(),
      public_enabled: c.public_enabled,
      updated_at: c.updated_at,
    }));

    const payload = {
      exported_at: new Date().toISOString(),
      policy_version: POLICY_VERSION,
      profile: profileRows[0] ?? null,
      contacts,
      consents: consentRows,
      memberships: membershipRows,
      notes: noteRows,
      blocks: blockRows,
      reports: reportRows,
      disclosure:
        'Contacts already revealed to other people through mutual introductions cannot be recalled by this export or by account deletion.',
    };

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="welcome-export-${new Date().toISOString().slice(0, 10)}.json"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    return internalError(err);
  }
}

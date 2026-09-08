import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { requireEncryptionKey } from '../../../../lib/env';
import { decryptValue, encryptValue } from '../../../../lib/crypto';
import { privateCacheHeaders, internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../lib/http';
import { validateContactInput } from '../../../../domain/profile';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const sql = getSql();
    const profileRows = await sql<{ id: string }[]>`
      SELECT id FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1
    `;
    const profile = profileRows[0];
    if (!profile) return jsonOk({ ok: true, contacts: [] }, { headers: privateCacheHeaders() });

    const key = requireEncryptionKey();
    const rows = await sql<{ kind: string; encrypted_value: string; public_enabled: boolean }[]>`
      SELECT kind, encrypted_value, public_enabled
      FROM contact_fields WHERE profile_id = ${profile.id}
      ORDER BY kind ASC
    `;
    const contacts = rows.map((r) => {
      let value: string;
      try {
        value = decryptValue(r.encrypted_value, key);
      } catch {
        value = ''; // undecryptable rows are never surfaced
      }
      return { kind: r.kind, value, public_enabled: r.public_enabled };
    });
    return jsonOk({ ok: true, contacts }, { headers: privateCacheHeaders() });
  } catch (err) {
    return internalError(err);
  }
}

async function putRoute(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const sql = getSql();
    const profileRows = await sql<{ id: string }[]>`
      SELECT id FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1
    `;
    const profile = profileRows[0];
    if (!profile) {
      return jsonError(400, 'profile_required', 'Create a profile first (POST /api/me/profile)');
    }

    const body = await readJsonBody(req);
    const input = validateContactInput(body);
    if (!input.ok) return jsonError(400, input.code, input.message);

    // Values are encrypted at rest (AES-256-GCM). Plaintext never reaches the DB.
    const encrypted = encryptValue(input.value.value, requireEncryptionKey());

    await sql`
      INSERT INTO contact_fields (profile_id, kind, encrypted_value, public_enabled)
      VALUES (${profile.id}, ${input.value.kind}, ${encrypted}, ${input.value.publicEnabled})
      ON CONFLICT (profile_id, kind)
      DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
                    public_enabled = EXCLUDED.public_enabled,
                    verified_at = NULL,
                    updated_at = now()
    `;

    return jsonOk({
      ok: true,
      contact: { kind: input.value.kind, public_enabled: input.value.publicEnabled },
    });
  } catch (err) {
    return internalError(err);
  }
}

export const PUT = withApi(putRoute);

import { NextRequest } from 'next/server';
import { getSql } from '../../../../lib/db';
import { requireAccount } from '../../../../lib/auth';
import { jsonError, jsonOk, readJsonBody, internalError } from '../../../../lib/http';
import { checkRevision, validateProfileInput } from '../../../../domain/profile';
import { generatePublicSlug } from '../../../../lib/crypto';

interface ProfileRow {
  public_slug: string;
  display_name: string;
  headline: string | null;
  company: string | null;
  short_bio: string | null;
  languages: string[];
  offer_tags: string[];
  need_tags: string[];
  revision: number;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const sql = getSql();
    const rows = await sql<ProfileRow[]>`
      SELECT public_slug, display_name, headline, company, short_bio,
             languages, offer_tags, need_tags, revision::int AS revision
      FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1
    `;
    const row = rows[0];
    return jsonOk({ ok: true, profile: row ?? null });
  } catch (err) {
    return internalError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const body = await readJsonBody(req);
    const input = validateProfileInput(body);
    if (!input.ok) {
      return jsonError(400, input.code, input.message);
    }
    const bodyObj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

    const sql = getSql();
    const existing = await sql<{ id: string; revision: number }[]>`
      SELECT id, revision::int AS revision FROM profiles WHERE account_id = ${auth.accountId} LIMIT 1
    `;
    const currentRow = existing[0];

    if (currentRow) {
      const current = currentRow.revision;

      if (typeof bodyObj.revision !== 'number') {
        return jsonError(400, 'revision_required', 'revision is required to update an existing profile');
      }

      // Fast, unit-tested check for stale revisions…
      const check = checkRevision(current, bodyObj.revision);
      if (!check.ok) {
        return jsonError(409, 'revision_conflict', 'Profile was changed by another request', {
          headers: { 'x-current-revision': String(check.currentRevision) },
        });
      }

      // …and an atomic compare-and-bump that stays race-safe under concurrency.
      const updated = await sql<ProfileRow[]>`
        UPDATE profiles SET
          display_name = ${input.value.displayName},
          headline = ${input.value.headline},
          company = ${input.value.company},
          short_bio = ${input.value.shortBio},
          languages = ${input.value.languages},
          offer_tags = ${input.value.offerTags},
          need_tags = ${input.value.needTags},
          revision = revision + 1,
          updated_at = now()
        WHERE id = ${currentRow.id} AND revision = ${current}
        RETURNING public_slug, display_name, headline, company, short_bio,
                  languages, offer_tags, need_tags, revision::int AS revision
      `;
      const row = updated[0];
      if (!row) {
        const now_current = await sql<{ revision: number }[]>`
          SELECT revision::int AS revision FROM profiles WHERE id = ${currentRow.id} LIMIT 1
        `;
        const cur = now_current[0]?.revision ?? current;
        return jsonError(409, 'revision_conflict', 'Profile was changed by another request', {
          headers: { 'x-current-revision': String(cur) },
        });
      }
      return jsonOk({ ok: true, profile: row, revision: row.revision });
    }

    // Create path: random 128-bit slug, retried on the (astronomically unlikely) collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const created = await sql<ProfileRow[]>`
          INSERT INTO profiles (account_id, public_slug, display_name, headline, company, short_bio, languages, offer_tags, need_tags)
          VALUES (${auth.accountId}, ${generatePublicSlug()}, ${input.value.displayName}, ${input.value.headline},
                  ${input.value.company}, ${input.value.shortBio}, ${input.value.languages},
                  ${input.value.offerTags}, ${input.value.needTags})
          RETURNING public_slug, display_name, headline, company, short_bio,
                    languages, offer_tags, need_tags, revision::int AS revision
        `;
        const row = created[0];
        if (row) {
          return jsonOk({ ok: true, profile: row, revision: row.revision });
        }
      } catch (e) {
        if (isUniqueViolation(e) && attempt < 4) continue;
        throw e;
      }
    }
    return jsonError(500, 'internal_error', 'Unexpected error. Please retry later.', { retryable: true });
  } catch (err) {
    return internalError(err);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

import { NextRequest } from 'next/server';
import { getSql } from '../../../../../lib/db';
import { requireAccount } from '../../../../../lib/auth';
import { internalError, jsonError, jsonOk, readJsonBody, withApi } from '../../../../../lib/http';
import { requireEventRole, isUuid } from '../../../../../domain/organizer';
import { parseCsv } from '../../../../../domain/csv';
import {
  mapCsvRows,
  validateMapping,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  IMPORT_PREVIEW_SAMPLE,
  type ImportMappingOverride,
  type ImportRecord,
} from '../../../../../domain/import';
import { emailLookupHash, encryptStored } from '../../../../../lib/crypto';
import { requireHashPepper, requireKeyring } from '../../../../../lib/env';
import { recordAudit } from '../../../../../lib/audit';

/** POST /api/events/[eventIdOrSlug]/imports — organizer CSV import.
 * Body: JSON { csv_text | csv_base64, mode: 'preview'|'commit', mapping? }
 * OR multipart/form-data { file: csv, mode, mapping? }.
 * `mapping` is `{csvColumn: field}` (fields: name, email, company, role/headline,
 * external_id, approval_status) and overrides auto-mapping for those columns.
 * Preview never writes; commit upserts registrations ONLY (no accounts/profiles). */

async function resolveEventId(idOrSlug: string): Promise<string | null> {
  const sql = getSql();
  if (isUuid(idOrSlug)) {
    const rows = await sql<{ id: string }[]>`SELECT id FROM events WHERE id = ${idOrSlug}::uuid`;
    return rows[0]?.id ?? null;
  }
  const rows = await sql<{ id: string }[]>`SELECT id FROM events WHERE slug = ${idOrSlug}`;
  return rows[0]?.id ?? null;
}

/** The upsert key the commit path uses: an explicit external id, else the email
 * lookup hash. Shared so preview counts the SAME rows commit would touch. */
function rowKey(rec: ImportRecord, pepper: string): string | null {
  const emailHash = rec.emailValid && rec.email ? emailLookupHash(rec.email, pepper) : null;
  return rec.externalId ?? (emailHash ? `email:${emailHash}` : null);
}

async function postRoute(
  req: NextRequest,
  { params }: { params: Promise<{ eventIdOrSlug: string }> },
) {
  try {
    const auth = await requireAccount(req);
    if (!auth) return jsonError(401, 'unauthorized', 'Sign in required');

    const { eventIdOrSlug } = await params;
    const eventId = await resolveEventId(eventIdOrSlug);
    if (!eventId) return jsonError(404, 'not_found', 'Event not found');

    const sql = getSql();
    const role = await requireEventRole(sql, auth.accountId, eventId, ['owner', 'admin']);
    if (!role) return jsonError(403, 'forbidden', 'You do not manage this event');

    // --- payload extraction: JSON or multipart ---------------------------------
    let csvText: string | null = null;
    let mode: 'preview' | 'commit' = 'preview';
    let mappingRaw: unknown = undefined;

    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData().catch(() => null);
      const file = form?.get('file');
      if (!file || typeof file === 'string' || file.size === 0) {
        return jsonError(400, 'csv_required', 'multipart body needs a non-empty file field named "file"');
      }
      csvText = await file.text();
      const modeRaw = form?.get('mode');
      if (typeof modeRaw === 'string' && (modeRaw === 'preview' || modeRaw === 'commit')) mode = modeRaw;
      const mapRaw = form?.get('mapping');
      if (typeof mapRaw === 'string' && mapRaw) {
        try { mappingRaw = JSON.parse(mapRaw); } catch { return jsonError(400, 'invalid_mapping', 'mapping must be valid JSON'); }
      }
    } else {
      const body = await readJsonBody(req);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return jsonError(400, 'invalid_body', 'JSON object expected');
      }
      const b = body as Record<string, unknown>;
      mode = b.mode === 'commit' ? 'commit' : 'preview';
      mappingRaw = b.mapping;
      if (typeof b.csv_text === 'string' && b.csv_text.length > 0) {
        csvText = b.csv_text;
      } else if (typeof b.csv_base64 === 'string' && b.csv_base64.length > 0) {
        try {
          csvText = Buffer.from(b.csv_base64, 'base64').toString('utf8');
        } catch {
          return jsonError(400, 'invalid_csv', 'csv_base64 could not be decoded');
        }
      }
    }
    if (csvText === null) return jsonError(400, 'csv_required', 'csv_text/csv_base64 or a file upload is required');

    const mappingInput: Record<string, unknown> =
      typeof mappingRaw === 'object' && mappingRaw !== null && !Array.isArray(mappingRaw)
        ? (mappingRaw as Record<string, unknown>)
        : {};
    if (mappingRaw !== undefined && mappingInput !== mappingRaw) {
      return jsonError(400, 'invalid_mapping', 'mapping must be an object of {csvColumn: field}');
    }

    // --- limits -----------------------------------------------------------------
    if (Buffer.byteLength(csvText, 'utf8') > IMPORT_MAX_BYTES) {
      return jsonError(413, 'payload_too_large', `CSV exceeds the ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)} MB limit`);
    }
    const parsed = parseCsv(csvText, { maxRows: IMPORT_MAX_ROWS });
    if (parsed.errors.length > 0) {
      return jsonError(400, 'csv_parse_error', parsed.errors[0]!);
    }
    if (parsed.truncated) {
      return jsonError(413, 'payload_too_large', `CSV exceeds the ${IMPORT_MAX_ROWS}-row limit`);
    }

    // The organizer's explicit mapping is validated against the real header and
    // REPLACES auto-mapping for the columns it names — a typo is a 400, never a
    // silent fallback to guessing.
    const validated = validateMapping(mappingInput, parsed.rows[0] ?? []);
    if (!validated.ok) return jsonError(400, validated.code, validated.message);
    const overrides: ImportMappingOverride = validated.mapping;

    const mapped = mapCsvRows(parsed.rows, overrides);
    const pepper = requireHashPepper();

    if (mode === 'preview') {
      // Would-be counts: same upsert key the commit path uses, one read-only
      // probe against the rows that already exist. Preview never writes.
      const keys = mapped.records.map((rec) => rowKey(rec, pepper));
      const candidates = [...new Set(keys.filter((k): k is string => k !== null))];
      let existingKeys = new Set<string>();
      if (candidates.length > 0) {
        const rows = await sql<{ external_guest_id: string }[]>`
          SELECT external_guest_id FROM registrations
          WHERE event_id = ${eventId} AND provider = 'csv'
            AND external_guest_id = ANY(${candidates}::text[])
        `;
        existingKeys = new Set(rows.map((r) => r.external_guest_id));
      }
      return jsonOk({
        ok: true,
        mapping: mapped.mapping,
        columns: mapped.columns,
        would_insert: candidates.filter((k) => !existingKeys.has(k)).length,
        would_update: candidates.filter((k) => existingKeys.has(k)).length,
        // Rows with neither an external id nor a valid email have no upsert key.
        would_skip: keys.filter((k) => k === null).length,
        quarantined_count: mapped.preview.quarantined,
        errors: mapped.errors.slice(0, 20),
        sample: mapped.preview.sample.slice(0, IMPORT_PREVIEW_SAMPLE),
        // Legacy shape kept verbatim for existing clients/tests.
        preview: mapped.preview,
      });
    }

    if (mapped.records.length === 0) {
      return jsonError(400, 'no_valid_rows', 'No importable rows found in the CSV');
    }

    const keyring = requireKeyring();
    let created = 0;
    let updated = 0;
    let skipped = 0;

    await sql.begin(async (tx) => {
      for (const rec of mapped.records) {
        const emailHash = rec.emailValid && rec.email ? emailLookupHash(rec.email, pepper) : null;
        const externalId = rowKey(rec, pepper);
        if (!externalId) {
          skipped++;
          continue;
        }

        const existing = await tx<{ id: string }[]>`
          SELECT id FROM registrations
          WHERE event_id = ${eventId} AND provider = 'csv' AND external_guest_id = ${externalId}
          LIMIT 1
          FOR UPDATE
        `;

        if (existing[0]) {
          await tx`
            UPDATE registrations SET
              imported_name = ${rec.name},
              imported_data = ${tx.json(rec.importedData)},
              approval_status = ${rec.approvalStatus},
              email_lookup_hash = COALESCE(${emailHash}, email_lookup_hash),
              encrypted_email = COALESCE(${emailHash ? encryptStored(rec.email!, keyring) : null}, encrypted_email),
              import_revision = import_revision + 1
            WHERE id = ${existing[0].id}
          `;
          updated++;
        } else {
          await tx`
            INSERT INTO registrations (event_id, provider, external_guest_id, email_lookup_hash, encrypted_email,
                                       imported_name, imported_data, approval_status)
            VALUES (${eventId}, 'csv', ${externalId}, ${emailHash}, ${emailHash ? encryptStored(rec.email!, keyring) : null},
                    ${rec.name}, ${tx.json(rec.importedData)}, ${rec.approvalStatus})
          `;
          created++;
        }
      }
    });

    await recordAudit(sql, auth.accountId, 'import.commit', 'event', eventId, {
      created,
      updated,
      skipped,
      quarantined: mapped.preview.quarantined,
    });

    return jsonOk({
      ok: true,
      mapping: mapped.mapping,
      counts: { created, updated, skipped, quarantined: mapped.preview.quarantined },
      errors: mapped.errors.slice(0, 20),
    });
  } catch (err) {
    return internalError(err);
  }
}

export const POST = withApi(postRoute);

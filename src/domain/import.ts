import { normalizeApprovalStatus, type NormalizedApprovalStatus } from './csv';

/** CSV import mapping/validation (pure). Raw CSV cells are stored as DATA —
 * nothing is ever executed; formula neutralization applies on export. */

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_PREVIEW_SAMPLE = 50;

export interface ImportMappingOverride {
  name?: string;
  email?: string;
  company?: string;
  role?: string;
  external_id?: string;
  approval_status?: string;
}

/** Fields the organizer may bind a CSV column to. */
export const IMPORT_FIELDS = ['name', 'email', 'company', 'role', 'external_id', 'approval_status'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Accepted spellings of a field name from the client. The brief names the
 * person's title as "role/headline", so both canonical spellings resolve to
 * `role` — and resolving them to ONE field is what makes the duplicate check
 * below catch "two columns, one field" no matter which spelling was typed. */
const IMPORT_FIELD_ALIASES: Record<string, ImportField> = {
  headline: 'role',
  title: 'role',
};

export type MappingErrorCode =
  | 'invalid_mapping'
  | 'unknown_mapping_field'
  | 'unknown_csv_column'
  | 'duplicate_mapping_field';

export type MappingValidation =
  | { ok: true; mapping: ImportMappingOverride }
  | { ok: false; code: MappingErrorCode; message: string };

function canonicalField(value: string): ImportField | null {
  const v = value.trim().toLowerCase();
  if ((IMPORT_FIELDS as readonly string[]).includes(v)) return v as ImportField;
  return IMPORT_FIELD_ALIASES[v] ?? null;
}

/**
 * Validates the organizer-supplied `{csvColumn: field}` mapping against the CSV
 * header. Returns the canonical `{field: csvColumn}` form ready for
 * `mapCsvRows`, using the header spelling exactly as it appears in the file.
 *
 * Rejection is explicit rather than silent: a typo in a column name must not
 * quietly fall back to auto-mapping, because the organizer would then believe a
 * column was imported when it was not.
 */
export function validateMapping(
  raw: Record<string, unknown>,
  columns: readonly string[],
): MappingValidation {
  const byColumn = new Map<string, string>();
  for (const column of columns) byColumn.set(column.trim().toLowerCase(), column);

  const mapping: ImportMappingOverride = {};
  const used = new Map<ImportField, string>();

  for (const [column, rawField] of Object.entries(raw)) {
    if (typeof rawField !== 'string' || rawField.trim().length === 0) {
      return {
        ok: false,
        code: 'invalid_mapping',
        message: `mapping["${column}"] must name an import field`,
      };
    }
    const field = canonicalField(rawField);
    if (!field) {
      return {
        ok: false,
        code: 'unknown_mapping_field',
        message: `mapping["${column}"]: unknown field "${rawField}" (expected one of ${IMPORT_FIELDS.join(', ')})`,
      };
    }
    const header = byColumn.get(column.trim().toLowerCase());
    if (!header) {
      return {
        ok: false,
        code: 'unknown_csv_column',
        message: `mapping["${column}"]: no such column in the CSV header`,
      };
    }
    const already = used.get(field);
    if (already) {
      return {
        ok: false,
        code: 'duplicate_mapping_field',
        message: `field "${field}" is mapped to both "${already}" and "${header}"`,
      };
    }
    used.set(field, header);
    mapping[field] = header;
  }

  return { ok: true, mapping };
}

export interface ImportRecord {
  name: string | null;
  email: string | null;
  emailValid: boolean;
  company: string | null;
  role: string | null;
  externalId: string | null;
  approvalStatus: NormalizedApprovalStatus;
  /** All non-empty CSV columns of the row, keyed by header. */
  importedData: Record<string, string>;
}

export interface ImportPreview {
  totalRows: number;
  validEmails: number;
  invalidEmails: number;
  quarantined: number;
  duplicatesInFile: number;
  sample: Record<string, string | null>[];
}

export interface MapResult {
  records: ImportRecord[];
  preview: ImportPreview;
  errors: string[];
  /** CSV header columns, in file order — the organizer picks from these. */
  columns: string[];
  /** Final field → column resolution (organizer override first, then auto). */
  mapping: Record<ImportField, string | null>;
}

const DEFAULT_HEADERS: Record<string, string[]> = {
  name: ['name', 'full_name', 'имя'],
  email: ['email', 'e-mail', 'почта'],
  company: ['company', 'организация', 'компания'],
  role: ['role', 'headline', 'title', 'должность', 'роль'],
  external_id: ['external_id', 'guest_id', 'id'],
  approval_status: ['approval_status', 'status', 'статус'],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeImportedEmail(value: string): { email: string | null; valid: boolean } {
  const v = value.trim().toLowerCase();
  if (v.length < 3 || v.length > 320 || !EMAIL_RE.test(v)) return { email: null, valid: false };
  return { email: v, valid: true };
}

function resolveHeaderIndex(header: (string | undefined)[], field: string, override?: string): number {
  if (override) {
    const wanted = override.trim().toLowerCase();
    const idx = header.findIndex((h) => h !== undefined && h.trim().toLowerCase() === wanted);
    if (idx >= 0) return idx;
  }
  const candidates = DEFAULT_HEADERS[field] ?? [field];
  return header.findIndex((h) => h !== undefined && candidates.includes(h.trim().toLowerCase()));
}

/** Maps parsed CSV rows (header included as rows[0]) to import records. */
export function mapCsvRows(rows: string[][], overrides: ImportMappingOverride = {}): MapResult {
  const errors: string[] = [];
  const records: ImportRecord[] = [];
  const emptyMapping = (): Record<ImportField, string | null> => ({
    name: null,
    email: null,
    company: null,
    role: null,
    external_id: null,
    approval_status: null,
  });
  if (rows.length === 0 || rows[0]!.length === 0) {
    errors.push('csv file has no header row');
    return {
      records,
      preview: { totalRows: 0, validEmails: 0, invalidEmails: 0, quarantined: 0, duplicatesInFile: 0, sample: [] },
      errors,
      columns: [],
      mapping: emptyMapping(),
    };
  }

  const header = rows[0]!;
  const idx = {
    name: resolveHeaderIndex(header, 'name', overrides.name),
    email: resolveHeaderIndex(header, 'email', overrides.email),
    company: resolveHeaderIndex(header, 'company', overrides.company),
    role: resolveHeaderIndex(header, 'role', overrides.role),
    externalId: resolveHeaderIndex(header, 'external_id', overrides.external_id),
    approvalStatus: resolveHeaderIndex(header, 'approval_status', overrides.approval_status),
  };

  // Echo the resolution so the UI can render "column → field" for review.
  const at = (i: number): string | null => (i >= 0 && i < header.length ? header[i]! : null);
  const mapping: Record<ImportField, string | null> = {
    name: at(idx.name),
    email: at(idx.email),
    company: at(idx.company),
    role: at(idx.role),
    external_id: at(idx.externalId),
    approval_status: at(idx.approvalStatus),
  };

  const preview: ImportPreview = {
    totalRows: rows.length - 1,
    validEmails: 0,
    invalidEmails: 0,
    quarantined: 0,
    duplicatesInFile: 0,
    sample: [],
  };

  const seen = new Set<string>();
  let rowNo = 1;
  for (const row of rows.slice(1)) {
    rowNo++;
    const cell = (i: number): string => (i >= 0 && i < row.length ? row[i]!.trim() : '');

    // imported_data keeps every non-empty column as plain data.
    const importedData: Record<string, string> = {};
    for (let c = 0; c < Math.min(header.length, row.length); c++) {
      const key = header[c]!.trim();
      const value = row[c]!.trim();
      if (key && value) importedData[key] = value;
    }

    const rawEmail = cell(idx.email);
    const { email, valid: emailValid } = normalizeImportedEmail(rawEmail);
    const name = cell(idx.name) || null;
    const externalId = cell(idx.externalId) || null;

    if (!name && !emailValid && !externalId) {
      errors.push(`row ${rowNo}: name or a valid email is required`);
      preview.totalRows = Math.max(0, preview.totalRows - 1);
      continue;
    }

    // Dedupe within the file: external id first, else normalized email.
    const dedupeKey = externalId ?? (emailValid ? `email:${email}` : null);
    if (dedupeKey && seen.has(dedupeKey)) {
      preview.duplicatesInFile++;
      continue;
    }
    if (dedupeKey) seen.add(dedupeKey);

    const approvalStatus = normalizeApprovalStatus(idx.approvalStatus >= 0 ? cell(idx.approvalStatus) : null);
    if (approvalStatus === 'quarantined') preview.quarantined++;
    if (emailValid) preview.validEmails++;
    else if (rawEmail) preview.invalidEmails++;

    const record: ImportRecord = {
      name,
      email,
      emailValid,
      company: cell(idx.company) || null,
      role: cell(idx.role) || null,
      externalId,
      approvalStatus,
      importedData,
    };
    records.push(record);

    if (preview.sample.length < IMPORT_PREVIEW_SAMPLE) {
      preview.sample.push({
        name: record.name,
        email: record.email,
        company: record.company,
        role: record.role,
        external_id: record.externalId,
        approval_status: record.approvalStatus,
      });
    }
  }

  return { records, preview, errors, columns: [...header], mapping };
}

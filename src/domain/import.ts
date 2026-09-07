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
  if (rows.length === 0 || rows[0]!.length === 0) {
    errors.push('csv file has no header row');
    return {
      records,
      preview: { totalRows: 0, validEmails: 0, invalidEmails: 0, quarantined: 0, duplicatesInFile: 0, sample: [] },
      errors,
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

  return { records, preview, errors };
}

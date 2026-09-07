/** CSV primitives: formula-injection neutralization, RFC4180-subset parser,
 * registration approval-status normalization (fail closed → quarantine).
 * Pure functions only — DB access stays in domain/routes. */

/** Prefixes spreadsheets interpret as formulas (OWASP CSV injection set). */
const FORMULA_PREFIX_RE = /^[=+\-@]/;

/** Neutralizes a cell that could execute as a spreadsheet formula:
 * leading `=` `+` `-` `@` gets a `'` prefix so re-exported data is inert. */
export function neutralizeCsvCell(value: string): string {
  return FORMULA_PREFIX_RE.test(value) ? `'${value}` : value;
}

export type NormalizedApprovalStatus = 'approved' | 'unknown' | 'quarantined';

/**
 * approval_status normalization (fail closed):
 * 'approved'/'confirmed' → approved; 'unknown'/''/missing → unknown;
 * ANY other value → quarantined (never guessed into approved).
 */
export function normalizeApprovalStatus(raw: string | null | undefined): NormalizedApprovalStatus {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'approved' || v === 'confirmed') return 'approved';
  if (v === '' || v === 'unknown') return 'unknown';
  return 'quarantined';
}

export interface CsvLimits {
  /** Max data rows (header excluded). Rows beyond the limit are still parsed but flagged via `truncated`. */
  maxRows?: number;
  /** Max columns per row; wider rows produce a structural error. */
  maxColumns?: number;
}

export interface CsvParseResult {
  /** Parsed rows; first row is the header when the file is non-empty. */
  rows: string[][];
  /** True when the data-row count exceeded limits.maxRows. */
  truncated: boolean;
  /** Structural problems (unterminated quote, too wide row) — callers must reject when non-empty. */
  errors: string[];
}

/** Default column cap; import mapping only needs a handful of fields. */
const DEFAULT_MAX_COLUMNS = 64;

/**
 * RFC4180-subset parser: comma-separated, `"`-quoted fields with `""` escapes,
 * CRLF/LF/CR record separators, UTF-8 BOM tolerated. Lenient on stray quotes
 * inside unquoted fields (treated as data); strict on unterminated quotes.
 */
export function parseCsv(text: string, limits?: CsvLimits): CsvParseResult {
  const errors: string[] = [];
  const maxColumns = limits?.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const maxRows = limits?.maxRows;

  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;
  let truncated = false;
  let i = 0;

  const pushField = () => {
    row.push(fieldWasQuoted ? field : field.trim());
    field = '';
    fieldWasQuoted = false;
  };

  const pushRow = () => {
    pushField();
    // Skip records that are entirely empty (e.g. blank lines between rows).
    if (row.length === 1 && row[0] === '') {
      row = [];
      return;
    }
    if (row.length > maxColumns) {
      errors.push(`row ${rows.length + 1}: ${row.length} columns exceed limit ${maxColumns}`);
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        fieldWasQuoted = true;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    // Opening quote at field start (whitespace-only prefix tolerated, then dropped).
    if (ch === '"' && !fieldWasQuoted && field.trim() === '') {
      field = '';
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      if (s[i + 1] === '\n') i++;
      pushRow();
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  if (inQuotes) {
    errors.push('unterminated quoted field at end of input');
  } else if (field !== '' || row.length > 0) {
    // Final record without a trailing newline.
    pushRow();
  }

  if (maxRows !== undefined && rows.length - 1 > maxRows) {
    truncated = true;
  }

  return { rows, truncated, errors };
}

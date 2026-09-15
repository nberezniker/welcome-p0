import { parseCsv } from './csv';

/**
 * Address-book import (interop §A1: «дружить с контактами» today, without
 * waiting for the owner's 15 minutes in Google Cloud).
 *
 * PURE by contract: this module reads a vCard/CSV text and returns
 * `{email, name}` pairs. It never touches the database, never writes a file and
 * never keeps the address book — the whole point of the feature is that the
 * user's contacts are processed in memory and forgotten, with only a peppered
 * HMAC lookup and two counts left behind (see the route).
 *
 * Two formats, one shape:
 *   - **vCard (.vcf)** — FN/N + EMAIL, several cards per file, folded lines,
 *     CRLF/LF/CR, group prefixes (`item1.EMAIL`). Parameters are dropped;
 *     payload-carrying properties (PHOTO/LOGO/KEY/SOUND) and properties that
 *     declare a base64/quoted-printable encoding are IGNORED rather than
 *     decoded — a half-decoded address is worse than an honest skip.
 *   - **CSV** — the existing RFC4180 subset parser (src/domain/csv.ts) plus
 *     column auto-detection by name (EN + RU), and a deterministic positional
 *     fallback when the header says nothing usable.
 *
 * Limits mirror the organizer import (src/domain/import.ts): 5 MB in, 5000
 * contacts out. Being over either one is reported, never silently trimmed —
 * "N of your contacts are here" must never mean "we dropped the rest".
 */

/** Max input size, in bytes of UTF-8 — same ceiling as the CSV import. */
export const CONTACT_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Max contacts extracted from one file. */
export const CONTACT_IMPORT_MAX_CONTACTS = 5000;

export type ContactImportFormat = 'vcard' | 'csv';

export interface ContactCandidate {
  /** Normalized (trim + lowercase) address. Never stored — only HMAC'd. */
  email: string;
  name: string | null;
}

export type ContactImportErrorCode =
  /** The input itself is over CONTACT_IMPORT_MAX_BYTES. */
  | 'payload_too_large'
  /** Nothing usable: no card/row carried a valid email address. */
  | 'no_contacts'
  /** The CSV is structurally broken — refusing beats importing half a file. */
  | 'csv_parse_error';

export interface ParsedContacts {
  ok: true;
  format: ContactImportFormat;
  contacts: ContactCandidate[];
  /** Entries dropped: cards/rows without an email, plus unusable addresses. */
  skipped: number;
  /** True when the file held more than CONTACT_IMPORT_MAX_CONTACTS contacts. */
  truncated: boolean;
}

export interface ContactImportFailure {
  ok: false;
  code: ContactImportErrorCode;
  message: string;
}

export type ContactImportResult = ParsedContacts | ContactImportFailure;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase + shape check; the one normalization used everywhere. */
function normalizeContactEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length < 3 || value.length > 320) return null;
  if (!EMAIL_RE.test(value)) return null;
  return value;
}

/** Accumulates contacts with the shared limits, dedupe and skip counting. */
class ContactCollector {
  readonly contacts: ContactCandidate[] = [];
  readonly seen = new Set<string>();
  skipped = 0;
  truncated = false;

  /**
   * Adds one candidate. A duplicate address is dropped quietly: the same person
   * listed twice (or with two spellings) is one contact, not a skip — `skipped`
   * counts entries that could not be used at all.
   */
  add(rawEmail: string, name: string | null): void {
    const email = normalizeContactEmail(rawEmail);
    if (email === null) {
      this.skipped++;
      return;
    }
    if (this.seen.has(email)) return;
    if (this.contacts.length >= CONTACT_IMPORT_MAX_CONTACTS) {
      this.truncated = true;
      return;
    }
    this.seen.add(email);
    this.contacts.push({ email, name });
  }
}


// ---------------------------------------------------------------------------
// vCard
// ---------------------------------------------------------------------------

/** Payload-carrying properties: never an address, and deliberately not decoded. */
const VCARD_BINARY_PROPERTIES = new Set([
  'PHOTO',
  'LOGO',
  'KEY',
  'SOUND',
  'X-ABLABEL',
  'X-ABSHOWAS',
  'X-ABUID',
  'X-IMAGE',
  'X-PHOTO',
]);

const VCARD_ENCODING_RE = /^ENCODING\s*[=:]\s*(B|BASE64|BASE-64|QUOTED-PRINTABLE|QP)$/i;

interface VCardProperty {
  name: string;
  /** Property parameters, upper-cased (`TYPE=WORK`, `ENCODING=BASE64`). */
  params: string[];
  value: string;
}

/**
 * Splits a card's lines into one property each, undoing line folding (a
 * continuation starts with a space or a tab) and dropping anything that is not
 * a `NAME[;params]:value` line — a raw base64 blob from a broken exporter
 * simply does not parse and is ignored.
 */
function parseVCardProperty(line: string): VCardProperty | null {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = head.split(';');
  let rawName = segments[0] ?? '';
  // vCard 4 group prefix: `item1.EMAIL`.
  const dot = rawName.lastIndexOf('.');
  if (dot >= 0) rawName = rawName.slice(dot + 1);
  const name = rawName.trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  return { name, params: segments.slice(1).map((p) => p.trim().toUpperCase()), value };
}

/** vCard text escaping (RFC 6350 §3.4), reduced to the characters we keep. */
function unescapeVCardValue(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/** The card's display name: FN if present, else N ("Family;Given" → "Given Family"). */
function vCardName(properties: readonly VCardProperty[]): string | null {
  const fn = properties.find((p) => p.name === 'FN');
  if (fn) {
    const value = unescapeVCardValue(fn.value);
    if (value.length > 0) return value;
  }
  const structured = properties.find((p) => p.name === 'N');
  if (structured) {
    const parts = unescapeVCardValue(structured.value)
      .split(';')
      .map((part) => part.trim());
    const family = parts[0] ?? '';
    const given = parts[1] ?? '';
    const composed = [given, family].filter((part) => part.length > 0).join(' ');
    if (composed.length > 0) return composed;
    // A single-token N ("Cher") is the family name and still the best we have.
    const first = parts.find((part) => part.length > 0);
    if (first) return first;
  }
  return null;
}

/** Cards of a `.vcf` text, each already unfolded into property lines. */
function vCardBlocks(text: string): string[][] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const marker = line.trim().toUpperCase();
    if (marker === 'BEGIN:VCARD') {
      current = [];
      continue;
    }
    if (marker === 'END:VCARD') {
      if (current) blocks.push(current);
      current = null;
      continue;
    }
    if (!current) continue; // junk outside a card is dropped
    if (/^[ \t]/.test(line) && current.length > 0) {
      current[current.length - 1] += line.slice(1);
      continue;
    }
    if (line.trim().length > 0) current.push(line.trimEnd());
  }
  // A truncated export may lack the final END:VCARD — keep what was read.
  if (current) blocks.push(current);
  return blocks;
}

function parseVCard(content: string, collector: ContactCollector): void {
  for (const block of vCardBlocks(content)) {
    if (collector.truncated) return;
    const properties: VCardProperty[] = [];
    for (const line of block) {
      const property = parseVCardProperty(line);
      if (!property) continue;
      if (VCARD_BINARY_PROPERTIES.has(property.name)) continue;
      if (property.params.some((param) => VCARD_ENCODING_RE.test(param))) continue;
      properties.push(property);
    }

    const name = vCardName(properties);
    const emails = properties.filter((p) => p.name === 'EMAIL');
    if (emails.length === 0) {
      collector.skipped++; // a card with no address at all
      continue;
    }
    // Every address of a card is offered: one person with two mailboxes is
    // exactly the case where "who is already here" should still answer yes.
    // Duplicates collapse inside the collector.
    for (const email of emails) collector.add(unescapeVCardValue(email.value), name);
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Header spellings, normalized (`e-mail` → `e mail`) before matching. */
const CSV_EMAIL_HEADERS = new Set([
  'email',
  'e mail',
  'mail',
  'email address',
  'e mail address',
  'почта',
  'мейл',
  'электронная почта',
]);
/** Exact name columns — preferred over "full" and "given" spellings. */
const CSV_NAME_EXACT = new Set(['name', 'имя']);
const CSV_NAME_FULL = new Set(['full name', 'fn', 'фио', 'имя и фамилия']);
const CSV_NAME_GIVEN = new Set(['given name', 'first name']);
/** Never a person's full name on its own — excluded from name resolution. */
const CSV_NAME_REJECT = /family|last|surname|middle|фамили|отчеств/;

/** `E-Mail` / `full_name` / `ФИО` → `e mail` / `full name` / `фио`. */
function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findHeaderIndex(header: readonly string[], wanted: Set<string>, reject?: RegExp): number {
  for (let i = 0; i < header.length; i++) {
    const cell = normalizeHeader(header[i] ?? '');
    if (reject && reject.test(cell)) continue;
    if (wanted.has(cell)) return i;
  }
  return -1;
}

function parseCsvContacts(content: string, collector: ContactCollector): ContactImportErrorCode | null {
  const parsed = parseCsv(content, { maxRows: CONTACT_IMPORT_MAX_CONTACTS });
  if (parsed.errors.length > 0) return 'csv_parse_error';
  if (parsed.rows.length === 0) return null;
  // More rows than the ceiling: the file is over the limit even if most rows
  // turn out to be unusable, so the caller is told the result is partial.
  if (parsed.truncated) collector.truncated = true;

  const header = parsed.rows[0]!;
  const emailIndex = findHeaderIndex(header, CSV_EMAIL_HEADERS);
  const nameIndex = (() => {
    const exact = findHeaderIndex(header, CSV_NAME_EXACT, CSV_NAME_REJECT);
    if (exact >= 0) return exact;
    const full = findHeaderIndex(header, CSV_NAME_FULL, CSV_NAME_REJECT);
    if (full >= 0) return full;
    return findHeaderIndex(header, CSV_NAME_GIVEN, CSV_NAME_REJECT);
  })();

  // No usable email column → deterministic positional read: the first
  // email-looking cell of a row is the contact, the cell to its left (when it is
  // not itself an address) is the name. The first row is data whenever it looks
  // like data — a headerless export must not lose its first person.
  const positional = emailIndex < 0;
  const firstRowIsData = positional && header.some((cell) => normalizeContactEmail(cell) !== null);
  const dataRows = positional
    ? firstRowIsData
      ? parsed.rows
      : parsed.rows.slice(1)
    : parsed.rows.slice(1);

  for (const row of dataRows) {
    if (positional) {
      let emailCell: string | null = null;
      let nameCell: string | null = null;
      for (let i = 0; i < row.length; i++) {
        const cell = (row[i] ?? '').trim();
        if (normalizeContactEmail(cell) !== null) {
          emailCell = cell;
          const left = (row[i - 1] ?? '').trim();
          nameCell = i > 0 && normalizeContactEmail(left) === null && left.length > 0 ? left : null;
          break;
        }
      }
      if (emailCell === null) {
        collector.skipped++;
        continue;
      }
      collector.add(emailCell, nameCell);
      continue;
    }

    const emailCell = (row[emailIndex] ?? '').trim();
    const name = nameIndex >= 0 ? (row[nameIndex] ?? '').trim() : '';
    if (emailCell.length === 0 && name.length === 0) continue; // truly empty row
    collector.add(emailCell, name.length > 0 ? name : null);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Format by content first (a `.vcf` that actually holds CSV is still CSV), filename second. */
export function detectContactFormat(content: string, filename?: string): ContactImportFormat {
  if (/^[ \t]*BEGIN:VCARD/im.test(content.replace(/^\uFEFF/, ''))) return 'vcard';
  if (/\.vcf$/i.test(filename ?? '')) return 'vcard';
  return 'csv';
}

/**
 * Parses an address book into `{email, name}` pairs.
 *
 * Never throws and never writes: an oversized, empty or broken input comes back
 * as `{ok: false, code}` so the route can answer honestly instead of guessing.
 */
export function parseContacts(
  content: string,
  opts: { filename?: string } = {},
): ContactImportResult {
  if (Buffer.byteLength(content, 'utf8') > CONTACT_IMPORT_MAX_BYTES) {
    return {
      ok: false,
      code: 'payload_too_large',
      message: `Address book exceeds the ${Math.round(CONTACT_IMPORT_MAX_BYTES / 1024 / 1024)} MB limit`,
    };
  }

  const format = detectContactFormat(content, opts.filename);
  const collector = new ContactCollector();
  if (format === 'vcard') {
    parseVCard(content, collector);
  } else {
    const failure = parseCsvContacts(content, collector);
    if (failure !== null) {
      return { ok: false, code: failure, message: 'The CSV could not be read from start to end' };
    }
  }

  if (collector.contacts.length === 0) {
    return { ok: false, code: 'no_contacts', message: 'No contacts with an email address were found' };
  }

  return {
    ok: true,
    format,
    contacts: collector.contacts,
    skipped: collector.skipped,
    truncated: collector.truncated,
  };
}

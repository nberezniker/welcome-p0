/**
 * TS port of the pure core from spec/contracts/matching.mjs.
 * Semantics must stay EXACTLY the same as the .mjs original (parity-tested
 * against the original file in tests/unit/matching-parity.test.ts).
 * No LLM, external calls, inferred sensitive attributes, or private contact fields.
 */

/** Trim, lowercase, dedupe; reject >80 chars and non-strings. Original semantics preserved. */
export function normalTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('Tags must be an array');
  return [
    ...new Set(
      value
        .map((x) => {
          if (typeof x !== 'string' || x.length > 80) throw new TypeError('Invalid tag');
          return x.trim().toLowerCase();
        })
        .filter(Boolean),
    ),
  ];
}

/** vCard text escaping: backslash first, then CRLF/CR/LF → \n, then ; and , . Original semantics preserved. */
export function escapeVCard(value: unknown): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

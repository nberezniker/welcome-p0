/**
 * Safe in-app redirect target validation (F-10).
 * A `?next=` value is only usable when it is a LOCAL path:
 *   - starts with a single '/';
 *   - NOT protocol-relative ('//evil.com');
 *   - NEVER contains a backslash — the WHATWG URL parser treats '\' as '/',
 *     so '/\evil.com' navigates off-site in browsers.
 * Returns null for anything else (the caller falls back to a fixed path).
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\')) return null;
  return value;
}

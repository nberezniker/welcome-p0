/**
 * Link fields for the card: kind detection by domain, strict validation and the
 * only href builder the UI may use.
 *
 * Rules (ONBOARDING_MINI_LANDING.md §«Подгрузить и подтвердить»): the user pastes
 * or confirms each link themselves; the kind is inferred from the domain and the
 * value is validated against an allowlist of schemes and known domain shapes.
 * The server NEVER fetches these URLs (SSRF rule, spec 04 §9) — validation is
 * purely syntactic, so nothing here needs network access.
 *
 * Pure module: no DOM, no fetch, unit-tested.
 */

export type LinkKind = 'linkedin_url' | 'website' | 'github_url' | 'telegram_username' | 'whatsapp';

export interface LinkKindDef {
  kind: LinkKind;
  /** Example shown in the inline validation hint. */
  example: string;
  /** Value is stored as a bare handle rather than a URL. */
  handle?: boolean;
}

export const LINK_KINDS: readonly LinkKindDef[] = [
  { kind: 'linkedin_url', example: 'https://www.linkedin.com/in/username' },
  { kind: 'github_url', example: 'https://github.com/username' },
  { kind: 'telegram_username', example: '@username', handle: true },
  { kind: 'whatsapp', example: '+34 600 000 000', handle: true },
  { kind: 'website', example: 'https://example.com' },
];

export const LINK_EXAMPLES: Record<LinkKind, string> = Object.fromEntries(
  LINK_KINDS.map((d) => [d.kind, d.example]),
) as Record<LinkKind, string>;

/** Schemes that must never reach an href — rejected before anything else. */
const FORBIDDEN_SCHEME = /^\s*(javascript|data|vbscript|file|blob)\s*:/i;

function hostOf(value: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function pathOf(value: string): string {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Infers the kind from the domain; anything else http(s) is a personal site. */
export function detectLinkKind(value: string): LinkKind {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'website';
  if (/^@[A-Za-z0-9_]{3,}$/.test(trimmed)) return 'telegram_username';
  if (/^\+?[\d\s()\-.]{6,}$/.test(trimmed)) return 'whatsapp';
  const host = hostOf(trimmed);
  if (!host) return 'website';
  if (hostMatches(host, 'linkedin.com')) return 'linkedin_url';
  if (hostMatches(host, 'github.com')) return 'github_url';
  if (hostMatches(host, 't.me') || hostMatches(host, 'telegram.me')) return 'telegram_username';
  if (hostMatches(host, 'wa.me') || hostMatches(host, 'whatsapp.com')) return 'whatsapp';
  return 'website';
}

export type LinkValidation =
  | { ok: true; kind: LinkKind; normalized: string }
  | { ok: false; reason: 'unsafe_scheme' | 'invalid' | 'wrong_domain' };

/**
 * Validates and normalizes a link for storage.
 * `kind` is implied by the field the user typed into, so a LinkedIn URL pasted
 * into the "website" field is accepted (the field is a hint, not a trap) — but a
 * value that contradicts the field's known domain shape is rejected, because that
 * is what a typo looks like.
 */
export function validateLink(rawValue: string, kind: LinkKind): LinkValidation {
  const value = rawValue.trim();
  if (value.length === 0) return { ok: false, reason: 'invalid' };
  if (FORBIDDEN_SCHEME.test(value)) return { ok: false, reason: 'unsafe_scheme' };
  if (value.length > 300) return { ok: false, reason: 'invalid' };

  switch (kind) {
    case 'telegram_username': {
      // Accepts "@user", "user", "t.me/user" and the full https://t.me/user URL.
      const match = /^(?:(?:https?:\/\/)?(?:t\.me|telegram\.me)\/)?@?([A-Za-z0-9_]{3,32})\/?$/.exec(value);
      if (!match) return { ok: false, reason: 'invalid' };
      return { ok: true, kind, normalized: `@${match[1]}` };
    }
    case 'whatsapp': {
      if (/^https?:\/\//i.test(value)) {
        const host = hostOf(value);
        if (!host || !(hostMatches(host, 'wa.me') || hostMatches(host, 'whatsapp.com'))) {
          return { ok: false, reason: 'wrong_domain' };
        }
      }
      const digits = value.replace(/[^\d+]/g, '');
      if (!/^\+?\d{6,15}$/.test(digits)) return { ok: false, reason: 'invalid' };
      return { ok: true, kind, normalized: digits.startsWith('+') ? digits : `+${digits}` };
    }
    case 'linkedin_url': {
      const host = hostOf(value);
      if (!host || !hostMatches(host, 'linkedin.com')) return { ok: false, reason: 'wrong_domain' };
      const path = pathOf(value);
      if (!/^\/(in|company|pub)\/[A-Za-z0-9\-_%.]+$/.test(path)) return { ok: false, reason: 'invalid' };
      return { ok: true, kind, normalized: normalizeHttp(value) };
    }
    case 'github_url': {
      const host = hostOf(value);
      if (!host || !hostMatches(host, 'github.com')) return { ok: false, reason: 'wrong_domain' };
      const path = pathOf(value);
      if (!/^\/[A-Za-z0-9\-_.]+$/.test(path)) return { ok: false, reason: 'invalid' };
      return { ok: true, kind, normalized: normalizeHttp(value) };
    }
    case 'website': {
      const host = hostOf(value);
      if (!host || !host.includes('.')) return { ok: false, reason: 'invalid' };
      return { ok: true, kind, normalized: normalizeHttp(value) };
    }
  }
}

function normalizeHttp(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withScheme);
  // Never keep credentials in a value that will be published.
  url.username = '';
  url.password = '';
  return url.toString();
}

/**
 * The only href builder for a stored link. Returns null when nothing safe can be
 * produced, so a caller renders plain text instead of a link.
 */
export function linkHref(kind: LinkKind, value: string): string | null {
  if (FORBIDDEN_SCHEME.test(value)) return null;
  switch (kind) {
    case 'telegram_username': {
      const handle = value.replace(/^@/, '').trim();
      return handle.length > 0 ? `https://t.me/${encodeURIComponent(handle)}` : null;
    }
    case 'whatsapp': {
      const digits = value.replace(/[^\d]/g, '');
      return digits.length > 0 ? `https://wa.me/${digits}` : null;
    }
    case 'linkedin_url':
    case 'github_url':
    case 'website': {
      try {
        const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        if (!url.hostname.includes('.')) return null;
        return url.toString();
      } catch {
        return null;
      }
    }
  }
}

/** True for kinds whose stored value is a URL (the ones the card renders as links). */
export function isUrlKind(kind: LinkKind): boolean {
  return kind === 'linkedin_url' || kind === 'github_url' || kind === 'website';
}

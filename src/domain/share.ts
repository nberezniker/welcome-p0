/**
 * Share deeplinks — the `publish` capability of the interop layer
 * (`docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md` §A3 "Share-deeplinks").
 *
 * There is no API here and that is the point: every target is a plain,
 * documented share URL that the VISITOR's click opens. We never post on
 * someone's behalf, never carry a token, and never parse anything back
 * (A1.1/A1.2). A network added here is a link, nothing more.
 *
 * Pure and deterministic — the component (src/components/share-links.tsx)
 * renders these hrefs and nothing else.
 */

export type ShareNetwork = 'linkedin' | 'whatsapp' | 'telegram' | 'x';

/** Display order, most useful first for a business-card share. */
export const SHARE_NETWORKS: readonly ShareNetwork[] = Object.freeze([
  'linkedin',
  'whatsapp',
  'telegram',
  'x',
]);

/**
 * Share URL for one network. `text` is only used where the network accepts it
 * (WhatsApp has no separate url field, so the link goes into the text).
 * Returns null for a value that is not an absolute http(s) URL — the caller
 * renders plain text rather than a dead link.
 */
export function shareHref(network: ShareNetwork, url: string, text?: string): string | null {
  const target = safeHttpUrl(url);
  if (!target) return null;
  const message = (text ?? '').trim();
  const encodedUrl = encodeURIComponent(target);
  const encodedText = encodeURIComponent(message);

  switch (network) {
    case 'linkedin':
      return `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`;
    case 'whatsapp': {
      const body = message.length > 0 ? `${message} ${target}` : target;
      return `https://wa.me/?text=${encodeURIComponent(body)}`;
    }
    case 'telegram':
      return message.length > 0
        ? `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`
        : `https://t.me/share/url?url=${encodedUrl}`;
    case 'x':
      return message.length > 0
        ? `https://x.com/intent/post?url=${encodedUrl}&text=${encodedText}`
        : `https://x.com/intent/post?url=${encodedUrl}`;
  }
}

/** Absolute http(s) URL, or null (relative paths are not shareable). */
function safeHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

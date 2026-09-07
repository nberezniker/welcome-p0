import { escapeVCard } from './matching';
import type { PublicProfile } from '../lib/public-profile';

/** Builds a vCard 3.0 payload with CRLF line endings and exact escapeVCard semantics.
 * Only explicitly public fields may be passed in. */
export function buildVCard(profile: PublicProfile): string {
  const lines: string[] = ['BEGIN:VCARD', 'VERSION:3.0'];
  lines.push(`FN:${escapeVCard(profile.display_name)}`);
  if (profile.company) lines.push(`ORG:${escapeVCard(profile.company)}`);
  if (profile.headline) lines.push(`TITLE:${escapeVCard(profile.headline)}`);
  if (profile.short_bio) lines.push(`NOTE:${escapeVCard(profile.short_bio)}`);
  for (const lang of profile.languages) {
    lines.push(`LANG:${escapeVCard(lang)}`);
  }
  for (const tag of profile.offer_tags) {
    lines.push(`X-WELCOME-OFFER:${escapeVCard(tag)}`);
  }
  for (const tag of profile.need_tags) {
    lines.push(`X-WELCOME-NEED:${escapeVCard(tag)}`);
  }
  for (const contact of profile.contacts) {
    switch (contact.kind) {
      case 'phone':
        lines.push(`TEL;TYPE=CELL:${escapeVCard(contact.value)}`);
        break;
      case 'whatsapp':
        lines.push(`TEL;TYPE=CELL;TYPE=WHATSAPP:${escapeVCard(contact.value)}`);
        break;
      case 'website':
        lines.push(`URL:${escapeVCard(contact.value)}`);
        break;
      case 'linkedin_url':
        lines.push(`X-SOCIALPROFILE;TYPE=linkedin:${escapeVCard(contact.value)}`);
        break;
      case 'telegram_username':
        lines.push(`X-SOCIALPROFILE;TYPE=telegram:${escapeVCard(toTelegramUrl(contact.value))}`);
        break;
    }
  }
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

/** telegram_username may be stored as "@user" or "user" — normalize for the URL. */
function toTelegramUrl(value: string): string {
  return `https://t.me/${value.replace(/^@/, '')}`;
}

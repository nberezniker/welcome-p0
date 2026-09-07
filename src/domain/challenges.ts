/** Link-challenge purposes and their TTLs (ADR ①): registration claim links
 * follow the event-registration horizon (7 days), while interactive binding
 * challenges stay at the 10-minute auth TTL. */

export const CHALLENGE_TTL_MINUTES: Record<string, number> = {
  registration_claim: 7 * 24 * 60,
  channel_binding: 10,
  telegram_link: 10,
};

const DEFAULT_TTL_MINUTES = 10;

export function challengeTtlMinutes(purpose: string): number {
  return CHALLENGE_TTL_MINUTES[purpose] ?? DEFAULT_TTL_MINUTES;
}

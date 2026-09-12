/** Link-challenge purposes and their TTLs (ADR ①, updated):
 * registration claim links follow the event-registration horizon (7 days).
 * telegram_link challenges run 24h: the real control is the two-sided binding
 * (a token is useless without the web-session confirmation), so a short
 * freshness window only creates friction for real users. */

export const CHALLENGE_TTL_MINUTES: Record<string, number> = {
  registration_claim: 7 * 24 * 60,
  channel_binding: 10,
  telegram_link: 24 * 60,
};

const DEFAULT_TTL_MINUTES = 10;

export function challengeTtlMinutes(purpose: string): number {
  return CHALLENGE_TTL_MINUTES[purpose] ?? DEFAULT_TTL_MINUTES;
}

/**
 * Enrichment limits shared by the server (route + provider transport) and the
 * client UI (the "N lookups per hour" message and the draft-link cap).
 *
 * They live in the domain rather than in the route/transport because the UI must
 * be able to state the SAME numbers the server enforces — a hardcoded "5" in a
 * component would silently drift the day the limit changes.
 */

/** GET/POST /api/me/enrich quota per account per hour. */
export const ENRICHMENT_RATE_LIMIT_PER_HOUR = 5;
/** Cap on the caller's own links handed to the provider (and on draft links applied). */
export const MAX_ENRICHMENT_LINKS = 5;

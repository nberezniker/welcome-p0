/**
 * "Does this target look production-like?" — asked by more than one command.
 *
 * WHY THIS IS ITS OWN MODULE. The question is asked by the two destructive
 * maintenance commands — `pnpm demo:reset` (src/domain/demo-reset.ts, which
 * erases a pair's introduction and a persona's membership) and `pnpm key:rotate`
 * (scripts/rotate-encryption-key.mts, which rewrites ciphertext in place). Both
 * must answer it the same way, because a different answer in one of them is a
 * silent hole: a command that decides "looks local" where its sibling decided
 * "looks production-like" runs against a live database without an
 * acknowledgement. The definition therefore lives once, here, and each command
 * imports it.
 *
 * The flag that lifts the refusal is shared too, for the same reason: an operator
 * who learned `--i-know-this-is-production` from one command finds that exactly
 * the same word works in the other, and neither command can drift into accepting
 * a more permissive spelling.
 *
 * The module is pure (no database driver, no Next.js, no env access of its own —
 * the caller passes what it read), so both a unit test and a script can drive it.
 */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** The explicit acknowledgement required when a target looks production-like. */
export const PRODUCTION_ACK_FLAG = '--i-know-this-is-production';

/**
 * Does this target look production-like? Deliberately fails CLOSED: an
 * unset/unparsable database URL or a non-local host counts as production-like,
 * so the acknowledgement flag is required rather than optional.
 */
export function looksProductionLike(input: { appEnv?: string | undefined; databaseUrl?: string | undefined }): boolean {
  if (input.appEnv === 'production') return true;
  const url = input.databaseUrl;
  if (!url || url.trim().length === 0) return true;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true; // a URL we cannot read is not one we will call local
  }
  return !LOCAL_HOSTS.includes(host.toLowerCase());
}

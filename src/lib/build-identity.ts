/**
 * Build/deployment identity for GET /api/health — OFF unless explicitly enabled.
 *
 * WHY IT IS OPT-IN, AND OFF BY DEFAULT. This project deliberately stopped
 * publishing `migration_version` on the public health payload (F-16): a public
 * endpoint should not fingerprint a deployment, because "which build is this"
 * is the first question an attacker asks and the last thing an uptime monitor
 * needs. That principle is not repealed here — the identity is exposed only when
 * an operator sets `HEALTH_EXPOSE_VERSION=true`, and the only other way to get it
 * is the existing secret-gated detailed payload.
 *
 * The flag exists because the principle has a legitimate exception: behind an
 * internal monitor or a canary check, "which build answered" is exactly the
 * question being asked, and forcing that operator to request the full detailed
 * payload (and therefore to distribute `WORKER_TICK_SECRET` to a monitor) would
 * trade a real secret for a non-secret.
 *
 * The value is the operator's own (`APP_BUILD_ID`, e.g. a git sha or an image
 * tag), never derived from the source tree or the host: this repository ships to
 * other people's deployments, so guessing one here would publish a wrong fact.
 * Unset → `null`, which is honest and distinct from "no identity configured".
 */

/** True when the operator has explicitly opted into publishing the identity. */
export function healthVersionExposed(): boolean {
  return process.env.HEALTH_EXPOSE_VERSION === 'true';
}

/**
 * The configured build identity, or `null` when the operator has not set one.
 * Trimmed, and an empty/whitespace-only value is `null` rather than `''` — a
 * blank string in a monitoring payload reads as a fact, and it is not one.
 */
export function buildId(): string | null {
  const value = (process.env.APP_BUILD_ID ?? '').trim();
  return value.length > 0 ? value : null;
}

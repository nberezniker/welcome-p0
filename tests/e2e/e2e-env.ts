/**
 * Fixtures shared by the Playwright config and the e2e specs.
 *
 * They live in one module so the value the SERVER runs with (webServer.env, read
 * by next.config.ts at boot) and the value the SPEC asserts cannot drift apart.
 *
 * Both are deliberately synthetic `.test` values rather than the release
 * deployment's real ones: the e2e suite must not depend on, or pin, the
 * upstream author's domain and inbox. Every deployment sets its own in the
 * environment (see SELF_HOSTING.md).
 */

/** `CANONICAL_ORIGIN` for the e2e server — where legacy hosts redirect to. */
export const E2E_CANONICAL_ORIGIN = 'https://canonical.welcome.test';

/** `OPERATOR_CONTACT_EMAIL` for the e2e server — the pilot/legal contact. */
export const E2E_OPERATOR_CONTACT_EMAIL = 'operator@welcome.test';

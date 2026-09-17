/**
 * Facts about the PROJECT itself (as opposed to a deployment of it).
 *
 * The repository URL is the same for every clone — it is the thing a self-hoster
 * cloned — so it is a constant, not configuration. Anything that varies between
 * deployments (the canonical origin, the operator's contact address) lives in
 * the environment instead; see src/lib/env.ts and SELF_HOSTING.md.
 */
export const PROJECT_REPO_URL = 'https://github.com/nberezniker/welcome-p0';

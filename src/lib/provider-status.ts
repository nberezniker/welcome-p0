/**
 * Provider status resolver — turns the static registry (src/domain/providers.ts)
 * into the honest, per-instance answer the UI and `GET /api/providers` need.
 *
 * Two questions are answered separately, on purpose:
 *
 *   1. WHAT the build does with a provider (`Provider.status`: live / planned /
 *      disabled) — a design decision, fixed at build time;
 *   2. WHAT THIS INSTANCE can actually do — the two live channel providers
 *      depend on env (Telegram bot token, Resend key), so an instance without
 *      them reports `disabled` + `not_configured` + the MISSING VARIABLE NAMES
 *      instead of pretending (A4 «Честные состояния»).
 *
 * The resolver is pure: it takes an env lookup function, so a unit test can
 * prove both branches without touching `process.env`, and the route handler can
 * prove that no VALUE ever reaches the payload — only names.
 */

import {
  PROVIDERS,
  REQUIRED_ENV,
  type Provider,
  type ProviderId,
  type ProviderReasonCode,
  type ProviderStatus,
} from '../domain/providers';

/** Reads a variable by NAME. `undefined`/blank means "not configured". */
export type EnvLookup = (name: string) => string | undefined;

export interface ProviderResolution {
  readonly status: ProviderStatus;
  readonly reason_code: ProviderReasonCode | null;
  /** Names of required env variables that are unset (never their values). */
  readonly missing_env: readonly string[];
}

/** Public projection of one provider — the exact shape of GET /api/providers. */
export interface PublicProvider extends ProviderResolution {
  readonly id: ProviderId;
  readonly kind: Provider['kind'];
  readonly auth: Provider['auth'];
  readonly capabilities: Provider['capabilities'];
  readonly direction: Provider['direction'];
  /** Env variable NAMES this provider's setup needs. Values are never read here. */
  readonly env: readonly string[];
}

/** Default lookup: process.env, treating whitespace-only as unset. */
export function processEnvLookup(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Status of one provider on this instance.
 *
 *   - a live provider whose required env is missing → `disabled` /
 *     `not_configured`, with the missing names;
 *   - otherwise the registry's own status and reason (planned / disabled are
 *     design states and cannot be flipped by configuration).
 */
export function resolveProviderStatus(
  provider: Provider,
  env: EnvLookup = processEnvLookup,
): ProviderResolution {
  const required = REQUIRED_ENV[provider.id] ?? [];
  if (provider.status === 'live' && required.length > 0) {
    const missing = required.filter((name) => env(name) === undefined);
    if (missing.length > 0) {
      return { status: 'disabled', reason_code: 'not_configured', missing_env: missing };
    }
  }
  return { status: provider.status, reason_code: provider.reason_code, missing_env: [] };
}

/** The public (allowlisted) projection of one provider. */
export function publicProvider(provider: Provider, env: EnvLookup = processEnvLookup): PublicProvider {
  const resolution = resolveProviderStatus(provider, env);
  return {
    id: provider.id,
    kind: provider.kind,
    auth: provider.auth,
    capabilities: provider.capabilities,
    direction: provider.direction,
    status: resolution.status,
    reason_code: resolution.reason_code,
    missing_env: resolution.missing_env,
    env: provider.setup.env,
  };
}

/** Every registered provider, in registry (table) order. */
export function resolveProviders(env: EnvLookup = processEnvLookup): PublicProvider[] {
  return PROVIDERS.map((provider) => publicProvider(provider, env));
}

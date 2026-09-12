import { createSign } from 'node:crypto';

/**
 * Credential resolution for the enrichment provider (Vertex AI).
 *
 * Two sources, in order:
 *   1. `GCP_ACCESS_TOKEN` — a pre-minted OAuth access token. This is the
 *      local-dev / ADC stand-in (produced by e.g.
 *      `gcloud auth application-default print-access-token`); the code NEVER
 *      shells out to gcloud itself, it only reads the env var.
 *   2. `GCP_SA_JSON` — a service-account key, accepted EITHER as raw JSON
 *      (starts with `{`) or as base64 of that JSON (auto-detected). Used via a
 *      SELF-SIGNED JWT: the assertion is signed locally with `crypto` and sent
 *      as the Bearer token, so no OAuth token endpoint has to be called and no
 *      extra outbound host is introduced. `GCP_SA_JSON_B64` is accepted as an
 *      alias because the deploy secret file already uses that name.
 *
 * No credentials → null → the provider is disabled and the route answers an
 * honest 503 instead of pretending to work.
 */

export interface TokenSource {
  readonly kind: 'gcp_access_token' | 'service_account_jwt';
  getToken(): Promise<string>;
}

export interface ServiceAccountCredential {
  clientEmail: string;
  privateKey: string;
}

/** Self-signed JWT audience for Vertex AI (Google APIs accept these). */
export const VERTEX_AUDIENCE = 'https://aiplatform.googleapis.com/';
const TOKEN_TTL_SECONDS = 3600;

/** Accepts raw JSON or base64-encoded JSON; returns null when unusable. */
export function parseServiceAccount(raw: string | undefined | null): ServiceAccountCredential | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let json = trimmed;
  if (!trimmed.startsWith('{')) {
    // base64 (standard or url-safe) → JSON
    try {
      json = Buffer.from(trimmed, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const sa = parsed as { client_email?: unknown; private_key?: unknown; type?: unknown };
  if (typeof sa.client_email !== 'string' || sa.client_email.length === 0) return null;
  if (typeof sa.private_key !== 'string' || !sa.private_key.includes('PRIVATE KEY')) return null;
  return { clientEmail: sa.client_email, privateKey: sa.private_key };
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Builds the RS256 self-signed JWT assertion for a service account. */
export function buildSelfSignedJwt(
  sa: ServiceAccountCredential,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: sa.clientEmail,
      sub: sa.clientEmail,
      aud: VERTEX_AUDIENCE,
      iat: nowSeconds,
      exp: nowSeconds + TOKEN_TTL_SECONDS,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(sa.privateKey, 'base64url');
  return `${signingInput}.${signature}`;
}

class StaticTokenSource implements TokenSource {
  readonly kind = 'gcp_access_token' as const;
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
}

export class ServiceAccountTokenSource implements TokenSource {
  readonly kind = 'service_account_jwt' as const;
  constructor(private readonly sa: ServiceAccountCredential) {}
  async getToken(): Promise<string> {
    return buildSelfSignedJwt(this.sa);
  }
}

/** Selects the credential source for the current environment, or null. */
export function selectTokenSource(env: Record<string, string | undefined> = process.env): TokenSource | null {
  const accessToken = env.GCP_ACCESS_TOKEN;
  if (accessToken && accessToken.trim().length > 0) return new StaticTokenSource(accessToken.trim());
  const sa = parseServiceAccount(env.GCP_SA_JSON) ?? parseServiceAccount(env.GCP_SA_JSON_B64);
  return sa ? new ServiceAccountTokenSource(sa) : null;
}

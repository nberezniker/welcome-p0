import { DisabledEnrichmentProvider } from './disabled-transport';
import { selectTokenSource } from './auth';
import { VertexEnrichmentTransport, type EnrichmentProvider } from './transport';

export type EnrichmentEnv = Record<string, string | undefined>;

function resolveAppEnv(env: EnrichmentEnv): 'development' | 'test' | 'production' {
  if (env.APP_ENV === 'production' || env.APP_ENV === 'test') return env.APP_ENV;
  return 'development';
}

/** Default model: the one verified live against this project (see the design doc). */
export const DEFAULT_GCP_MODEL = 'gemini-2.5-flash';
export const DEFAULT_GCP_LOCATION = 'global';

// TEST ONLY — loaded lazily behind the env gate so production bundles never
// evaluate mock-transport.ts at module load.
let mockPromise: Promise<EnrichmentProvider> | null = null;

function loadMock(): Promise<EnrichmentProvider> {
  if (!mockPromise) {
    mockPromise = import('./mock-transport').then((m) => new m.MockEnrichmentProvider());
  }
  return mockPromise;
}

/**
 * Provider selection matrix (mirrors the email/telegram adapters):
 *   1. ENRICHMENT_PROVIDER=vertex|vertex-gemini with a project id AND a
 *      credential source        → Vertex AI transport (any env)
 *   2. ENRICHMENT_PROVIDER=mock, APP_ENV !== production → mock (dev/tests only)
 *   3. anything else (unset, unknown, mock in PRODUCTION, vertex without
 *      credentials)             → disabled provider: the route answers an honest
 *      503 `enrichment_disabled` with retryable:false.
 */
export async function selectEnrichmentProvider(env: EnrichmentEnv = process.env): Promise<EnrichmentProvider> {
  const kind = (env.ENRICHMENT_PROVIDER ?? '').trim().toLowerCase();

  if (kind === 'vertex' || kind === 'vertex-gemini') {
    const projectId = env.GCP_PROJECT_ID?.trim();
    const tokenSource = selectTokenSource(env);
    if (!projectId || !tokenSource) {
      return new DisabledEnrichmentProvider('enrichment_not_configured');
    }
    return new VertexEnrichmentTransport({
      projectId,
      location: env.GCP_LOCATION?.trim() || DEFAULT_GCP_LOCATION,
      model: env.GCP_MODEL?.trim() || DEFAULT_GCP_MODEL,
      tokenSource,
    });
  }

  if (kind === 'mock') {
    if (resolveAppEnv(env) === 'production') {
      return new DisabledEnrichmentProvider('enrichment_disabled');
    }
    return loadMock();
  }

  return new DisabledEnrichmentProvider('enrichment_disabled');
}

export { DisabledEnrichmentProvider } from './disabled-transport';
export { VertexEnrichmentTransport } from './transport';
export {
  buildSelfSignedJwt,
  parseServiceAccount,
  selectTokenSource,
  ServiceAccountTokenSource,
  VERTEX_AUDIENCE,
  type ServiceAccountCredential,
  type TokenSource,
} from './auth';
export {
  enrichmentPrompt,
  extractJsonObject,
  extractSources,
  parseEnrichmentAnswer,
  sanitizeSuggestions,
  ENRICHMENT_MAX_OUTPUT_TOKENS,
  MAX_ENRICHMENT_LINKS,
  ENRICHMENT_REQUEST_TIMEOUT_MS,
  type EnrichmentDraft,
  type EnrichmentProvider,
  type EnrichmentRequest,
  type EnrichmentResult,
  type EnrichmentSource,
} from './transport';

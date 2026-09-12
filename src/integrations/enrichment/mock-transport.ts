// TEST ONLY — CI fails if enabled in production build.
// Deterministic, offline enrichment provider: returns a fixed draft derived
// from the request so integration tests can assert the endpoint contract
// (draft + sources + "nothing persisted") without touching Vertex.
// It MUST only be selected by selectEnrichmentProvider() when
// ENRICHMENT_PROVIDER=mock AND APP_ENV !== 'production'.
import type { EnrichmentDraft, EnrichmentProvider, EnrichmentRequest, EnrichmentResult } from './transport';

export class MockEnrichmentProvider implements EnrichmentProvider {
  readonly name = 'enrichment_mock';
  readonly enabled = true;

  /** Every request this provider received, for assertions. */
  public readonly requests: EnrichmentRequest[] = [];

  constructor(private readonly scripted: EnrichmentResult | null = null) {}

  async enrich(request: EnrichmentRequest): Promise<EnrichmentResult> {
    this.requests.push(request);
    if (this.scripted) return this.scripted;
    const draft: EnrichmentDraft = {
      headline: `Mock headline for ${request.displayName}`,
      short_bio: `Mock bio. Company: ${request.company ?? 'n/a'}. Industry: ${request.industry ?? 'n/a'}.`,
      company: request.company,
      links: request.links.slice(0, 5),
      suggested_interests: ['ai-ml', 'startups'],
      suggested_intents: ['seeking-cofounder', 'open-to-cofound'],
    };
    return {
      state: 'ok',
      draft,
      sources: [
        { title: 'Mock source', uri: 'https://example.com/mock-source' },
        { title: 'Mock second source', uri: 'https://example.com/mock-source-2' },
      ],
      provider: this.name,
    };
  }
}

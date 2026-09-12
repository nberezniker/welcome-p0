import type { EnrichmentProvider, EnrichmentResult } from './transport';

/**
 * Disabled provider: no enrichment credentials (or the provider is unset).
 * The route answers 503 `enrichment_disabled` with retryable:false — an honest,
 * explicit failure. We never silently pretend success and never fall back to a
 * mock outside the explicit dev/mock gate.
 */
export class DisabledEnrichmentProvider implements EnrichmentProvider {
  readonly name = 'enrichment_disabled';
  readonly enabled = false;

  constructor(private readonly reason: string = 'enrichment_disabled') {}

  async enrich(): Promise<EnrichmentResult> {
    return { state: 'disabled', code: this.reason, retryable: false };
  }
}

/**
 * Enrichment provider contract + the Vertex AI (Gemini + Google Search
 * grounding) transport.
 *
 * Privacy invariant (docs-internal/product/ONBOARDING_MINI_LANDING.md): the
 * provider is called for the requesting user's OWN profile only, with only the
 * identifiers they already own — display name, company, industry and their own
 * confirmed links. The result is a DRAFT: nothing is persisted and nothing is
 * published without an explicit line-by-line confirmation in the UI. No
 * LinkedIn/Instagram scraping, no third-party enrichment, no bulk use.
 *
 * Outbound call: POST https://aiplatform.googleapis.com/v1/projects/{project}
 *   /locations/{location}/publishers/google/models/{model}:generateContent
 *   with tools:[{googleSearch:{}}] and the x-goog-user-project header.
 *
 * Outcome mapping mirrors the email/telegram transports:
 *   2xx with parsable JSON draft → 'ok'
 *   429 / 5xx / timeout / network error → 'failed' (+ retryable)
 *   anything else (4xx, unparsable draft)  → 'failed' (permanent, no retry)
 */

import {
  MAX_INTERESTS,
  MAX_KEYWORDS,
  MAX_NEED_INTENTS,
  MAX_OFFER_INTENTS,
  normalizeInterest,
  strictIntentForKind,
} from '../../domain/taxonomy';
import type { TokenSource } from './auth';

export const ENRICHMENT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Output budget for one generateContent call. gemini-2.5-flash is a THINKING
 * model: its reasoning tokens are charged against this budget, and Google
 * Search grounding injects a large tool-use prompt on top. Measured live:
 * with the previous 1024 cap every call returned HTTP 200, finishReason STOP
 * and an EMPTY visible answer (thoughts alone reached 2904 tokens) — the route
 * then reported `no_draft` on a perfectly healthy call. 8192 leaves room for
 * the thoughts plus the JSON draft. Grounding answers stay stochastic even so:
 * an empty answer is a retryable failure, never a fake success.
 */
export const ENRICHMENT_MAX_OUTPUT_TOKENS = 8192;
/** Cap on the caller's own links handed to the provider. */
export const MAX_ENRICHMENT_LINKS = 5;
/** Cap on the returned free-form links. */
const MAX_DRAFT_LINKS = 5;
const MAX_HEADLINE = 200;
const MAX_SHORT_BIO = 1000;
const MAX_COMPANY = 120;

export interface EnrichmentSource {
  title: string;
  uri: string;
}

export interface EnrichmentDraft {
  headline: string | null;
  short_bio: string | null;
  company: string | null;
  links: string[];
  suggested_interests: string[];
  suggested_intents: string[];
}

/** Only the requester's own data ever goes in here. */
export interface EnrichmentRequest {
  displayName: string;
  company: string | null;
  industry: string | null;
  /** The user's own confirmed links (their site / LinkedIn / GitHub / Telegram). */
  links: string[];
}

export interface EnrichmentResult {
  state: 'ok' | 'failed' | 'disabled';
  draft?: EnrichmentDraft;
  sources?: EnrichmentSource[];
  provider?: string;
  code?: string;
  retryable?: boolean;
}

export interface EnrichmentProvider {
  readonly name: string;
  /** False for the disabled provider — lets the route answer 503 before spending quota. */
  readonly enabled: boolean;
  enrich(request: EnrichmentRequest): Promise<EnrichmentResult>;
}

/** The strict "own profile only" instruction. The model must not guess beyond it. */
export function enrichmentPrompt(request: EnrichmentRequest): string {
  const links = request.links.length > 0 ? request.links.join('\n') : '(no links provided)';
  return [
    'You are enriching ONE consenting person\'s own professional profile for a networking app.',
    'Use ONLY the identifiers below. This is their own data, submitted by them.',
    'Rules:',
    '- Never enrich a different or third person, never aggregate people, never guess private data.',
    '- Do not invent employers, titles, schools or achievements. If the public footprint is thin, return nulls/empty arrays.',
    '- Search the open web for the person\'s own public professional footprint only.',
    `- suggested_interests: at most ${MAX_INTERESTS} ids from the allowed interest list.`,
    `- suggested_intents: at most ${MAX_NEED_INTENTS + MAX_OFFER_INTENTS} ids from the allowed intent list.`,
    '- links: at most 5 public http(s) URLs you actually found and can source.',
    '',
    'Person (own profile):',
    `display_name: ${request.displayName}`,
    `company: ${request.company ?? '(not provided)'}`,
    `industry: ${request.industry ?? '(not provided)'}`,
    'own links:',
    links,
    '',
    'Respond with a SINGLE JSON object and nothing else, exactly this shape:',
    '{"headline": string|null, "short_bio": string|null, "company": string|null,',
    ' "links": string[], "suggested_interests": string[], "suggested_intents": string[]}',
    'Allowed interest ids and intent ids are defined by the app catalogue; only emit ids you are confident about.',
  ].join('\n');
}

/** Extracts the first balanced JSON object from a model answer (tolerates fences/prose). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function textField(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length === 0) return null;
  return v.slice(0, maxLength);
}

function httpLinks(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!v) continue;
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (out.includes(v)) continue;
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

/** Catalogue-sanitized suggestions: unknown ids from the model are dropped
 * (never an error — a model may guess, the catalogue is the arbiter). */
export function sanitizeSuggestions(draft: Record<string, unknown>): Pick<EnrichmentDraft, 'suggested_interests' | 'suggested_intents'> {
  const interestsRaw = Array.isArray(draft['suggested_interests']) ? draft['suggested_interests'] : [];
  const interests: string[] = [];
  for (const item of interestsRaw) {
    const id = normalizeInterest(item);
    if (id && !interests.includes(id)) interests.push(id);
    if (interests.length >= MAX_INTERESTS) break;
  }

  const intentsRaw = Array.isArray(draft['suggested_intents']) ? draft['suggested_intents'] : [];
  const needs: string[] = [];
  const offers: string[] = [];
  for (const item of intentsRaw) {
    const need = strictIntentForKind(item, 'need');
    const offer = need ? null : strictIntentForKind(item, 'offer');
    if (need && !needs.includes(need) && needs.length < MAX_NEED_INTENTS) needs.push(need);
    else if (offer && !offers.includes(offer) && offers.length < MAX_OFFER_INTENTS) offers.push(offer);
  }
  return {
    suggested_interests: interests,
    suggested_intents: [...needs, ...offers],
  };
}

/**
 * Turns a raw model answer into a validated draft. Returns null when the answer
 * carries no usable JSON, which the caller maps to a failed enrichment.
 */
export function parseEnrichmentAnswer(
  text: string,
  sources: EnrichmentSource[],
): { draft: EnrichmentDraft; sources: EnrichmentSource[] } | null {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;
  const suggestions = sanitizeSuggestions(parsed);
  const draft: EnrichmentDraft = {
    headline: textField(parsed['headline'], MAX_HEADLINE),
    short_bio: textField(parsed['short_bio'], MAX_SHORT_BIO),
    company: textField(parsed['company'], MAX_COMPANY),
    links: httpLinks(parsed['links'], MAX_DRAFT_LINKS),
    suggested_interests: suggestions.suggested_interests.slice(0, MAX_INTERESTS),
    suggested_intents: suggestions.suggested_intents,
  };
  const hasContent =
    draft.headline !== null ||
    draft.short_bio !== null ||
    draft.company !== null ||
    draft.links.length > 0 ||
    draft.suggested_interests.length > 0 ||
    draft.suggested_intents.length > 0;
  if (!hasContent) return null;
  return { draft, sources };
}

export { MAX_KEYWORDS };

interface GroundingChunk {
  web?: { uri?: unknown; title?: unknown };
}

interface VertexResponse {
  candidates?: {
    content?: { parts?: { text?: unknown }[] };
    groundingMetadata?: { groundingChunks?: GroundingChunk[] };
  }[];
}

/** Grounding sources from groundingMetadata.groundingChunks (titles + URIs). */
export function extractSources(body: VertexResponse): EnrichmentSource[] {
  const chunks = body.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const out: EnrichmentSource[] = [];
  for (const chunk of chunks) {
    const uri = chunk.web?.uri;
    if (typeof uri !== 'string' || uri.length === 0) continue;
    if (out.some((s) => s.uri === uri)) continue;
    const title = typeof chunk.web?.title === 'string' && chunk.web.title.length > 0 ? chunk.web.title : uri;
    out.push({ title, uri });
  }
  return out;
}

export function vertexAnswerText(body: VertexResponse): string {
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
}

export interface VertexOptions {
  projectId: string;
  location: string;
  model: string;
  tokenSource: TokenSource;
}

export class VertexEnrichmentTransport implements EnrichmentProvider {
  readonly name = 'vertex_gemini';
  readonly enabled = true;

  constructor(private readonly options: VertexOptions) {}

  private endpoint(): string {
    const { projectId, location, model } = this.options;
    return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
  }

  async enrich(request: EnrichmentRequest): Promise<EnrichmentResult> {
    let token: string;
    try {
      token = await this.options.tokenSource.getToken();
    } catch {
      return { state: 'failed', code: 'enrichment_auth_failed', retryable: false };
    }

    let res: Response;
    try {
      res = await fetch(this.endpoint(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-goog-user-project': this.options.projectId,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: enrichmentPrompt(request) }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: { temperature: 0.2, maxOutputTokens: ENRICHMENT_MAX_OUTPUT_TOKENS },
        }),
        signal: AbortSignal.timeout(ENRICHMENT_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return { state: 'failed', code: timedOut ? 'timeout' : 'network_error', retryable: true };
    }

    if (res.status === 429 || res.status >= 500) {
      return { state: 'failed', code: res.status === 429 ? 'rate_limited' : 'upstream_5xx', retryable: true };
    }
    if (!res.ok) {
      // Permanent: never leak provider details beyond the raw status.
      return { state: 'failed', code: `upstream_${res.status}`, retryable: false };
    }

    let body: VertexResponse;
    try {
      body = (await res.json()) as VertexResponse;
    } catch {
      return { state: 'failed', code: 'bad_response', retryable: true };
    }

    const parsed = parseEnrichmentAnswer(vertexAnswerText(body), extractSources(body));
    if (!parsed) return { state: 'failed', code: 'no_draft', retryable: true };

    return { state: 'ok', draft: parsed.draft, sources: parsed.sources, provider: this.name };
  }
}

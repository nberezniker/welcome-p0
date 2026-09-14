import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GCP_LOCATION,
  DEFAULT_GCP_MODEL,
  ENRICHMENT_MAX_OUTPUT_TOKENS,
  degradedEnrichmentDraft,
  enrichmentPrompt,
  VertexEnrichmentTransport,
  type EnrichmentRequest,
} from '../../src/integrations/enrichment';

// ---------------------------------------------------------------------------
// BUG-3 (2026-09-14 usage-matrix): the live grounded provider periodically
// answers HTTP 200 with no parsable draft. The transport must retry such an
// answer exactly ONCE (same request, same token budget) and report the failure
// honestly afterwards; the route then falls back to a deterministic draft built
// from the caller's own profile fields.
// ---------------------------------------------------------------------------

const REQUEST: EnrichmentRequest = {
  displayName: 'Анна Смирнова',
  company: 'Acme Labs',
  industry: 'ai-saas',
  jobFunction: 'founder-ceo',
  links: [],
};

/** A vertex candidate body with an empty visible answer (the live flake). */
const EMPTY_ANSWER = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '' }] } }] };

/** A well-formed model answer carrying a real draft. */
const GOOD_ANSWER = {
  candidates: [
    {
      content: {
        parts: [
          {
            text: '{"headline":"Founder at Acme Labs","short_bio":"Builds things.","company":"Acme Labs",' +
              '"links":[],"suggested_interests":["ai-ml"],"suggested_intents":["seeking-cofounder"]}',
          },
        ],
      },
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://acme.example', title: 'Acme' } }] },
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function provider(): VertexEnrichmentTransport {
  return new VertexEnrichmentTransport({
    projectId: 'my-project',
    location: DEFAULT_GCP_LOCATION,
    model: DEFAULT_GCP_MODEL,
    tokenSource: { kind: 'gcp_access_token', getToken: async () => 'ya29.test-token' },
  });
}

/** Runs `enrich` against a scripted sequence of responses; returns the calls. */
async function withScriptedFetch(
  script: (call: number) => Response,
  run: (p: VertexEnrichmentTransport) => Promise<unknown>,
): Promise<{ result: Awaited<ReturnType<VertexEnrichmentTransport['enrich']>>; bodies: string[] }> {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: unknown) => {
    bodies.push(String((init as RequestInit).body));
    return script(bodies.length);
  }) as typeof fetch;
  try {
    const result = (await run(provider())) as Awaited<ReturnType<VertexEnrichmentTransport['enrich']>>;
    return { result, bodies };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('transport: an empty answer is retried exactly once, then reported as no_draft', async () => {
  const { result, bodies } = await withScriptedFetch(
    () => jsonResponse(EMPTY_ANSWER),
    (p) => p.enrich(REQUEST),
  );
  assert.equal(bodies.length, 2, 'one internal retry — and never a third call');
  // The retry must not change the request: same prompt, same token budget.
  assert.equal(bodies[0], bodies[1]);
  const body = JSON.parse(bodies[1]!) as {
    generationConfig: { maxOutputTokens: number };
    contents: { parts: { text: string }[] }[];
  };
  assert.equal(body.generationConfig.maxOutputTokens, ENRICHMENT_MAX_OUTPUT_TOKENS);
  assert.match(body.contents[0]!.parts[0]!.text, /Анна Смирнова/);

  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'no_draft');
  assert.equal(result.retryable, true);
});

test('transport: the retry recovers a draft when the second answer parses', async () => {
  const { result, bodies } = await withScriptedFetch(
    (call) => jsonResponse(call === 1 ? EMPTY_ANSWER : GOOD_ANSWER),
    (p) => p.enrich(REQUEST),
  );
  assert.equal(bodies.length, 2);
  assert.equal(result.state, 'ok');
  assert.equal(result.draft?.headline, 'Founder at Acme Labs');
  assert.equal(result.draft?.company, 'Acme Labs');
  assert.deepEqual(result.draft?.suggested_interests, ['ai-ml']);
  assert.deepEqual(result.sources, [{ title: 'Acme', uri: 'https://acme.example' }]);
  assert.equal(result.provider, 'vertex_gemini');
});

test('transport: a real failure is not retried internally (only the client may re-ask)', async () => {
  const upstream = await withScriptedFetch(() => jsonResponse({ error: 'boom' }, 500), (p) => p.enrich(REQUEST));
  assert.equal(upstream.bodies.length, 1, '5xx is reported retryable without an internal repeat');
  assert.equal(upstream.result.code, 'upstream_5xx');
  assert.equal(upstream.result.retryable, true);

  const throttled = await withScriptedFetch(() => jsonResponse({ error: 'slow down' }, 429), (p) => p.enrich(REQUEST));
  assert.equal(throttled.bodies.length, 1);
  assert.equal(throttled.result.code, 'rate_limited');

  const permanent = await withScriptedFetch(() => jsonResponse({ error: 'nope' }, 400), (p) => p.enrich(REQUEST));
  assert.equal(permanent.bodies.length, 1);
  assert.equal(permanent.result.code, 'upstream_400');
  assert.equal(permanent.result.retryable, false);
});

test('transport: an unparsable HTTP-200 body is treated as an empty answer and retried once', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  try {
    const result = await provider().enrich(REQUEST);
    assert.equal(calls, 2);
    assert.equal(result.code, 'bad_response');
    assert.equal(result.retryable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('prompt: demands a best-effort draft always and JSON only', () => {
  const prompt = enrichmentPrompt(REQUEST);
  assert.match(prompt, /ALWAYS return a best-effort draft/);
  assert.match(prompt, /Never return an empty answer/);
  assert.match(prompt, /SINGLE JSON object and nothing else/);
  // The own fields the fallback may be composed from are all in the prompt.
  assert.match(prompt, /job_function: founder-ceo/);
  assert.match(prompt, /company: Acme Labs/);
  assert.match(prompt, /industry: ai-saas/);
  // The no-invention rule survives.
  assert.match(prompt, /Do not invent/);
});

// ---------------------------------------------------------------------------
// Deterministic degraded draft (route fallback, BUG-3b)
// ---------------------------------------------------------------------------

test('degraded draft: purely own data, deterministic, and it invented nothing', () => {
  const input = {
    displayName: 'Анна Смирнова',
    company: 'Acme Labs',
    jobFunction: 'Founder & CEO',
    industry: 'AI SaaS',
  };
  const first = degradedEnrichmentDraft(input);
  assert.deepEqual(degradedEnrichmentDraft(input), first, 'same input → same draft');

  assert.equal(first.headline, 'Founder & CEO · Acme Labs');
  assert.equal(first.short_bio, 'Анна Смирнова — Founder & CEO at Acme Labs · AI SaaS.');
  assert.equal(first.company, 'Acme Labs');
  // Nothing is claimed about the web: no links, no catalogue suggestions.
  assert.deepEqual(first.links, []);
  assert.deepEqual(first.suggested_interests, []);
  assert.deepEqual(first.suggested_intents, []);

  // Partial profiles still yield a usable draft.
  assert.equal(degradedEnrichmentDraft({ ...input, company: null }).headline, 'Founder & CEO');
  assert.equal(degradedEnrichmentDraft({ ...input, jobFunction: null, industry: null }).headline, 'Acme Labs');
  assert.equal(degradedEnrichmentDraft({ ...input, jobFunction: null, industry: 'AI SaaS' }).headline, 'Acme Labs');
  assert.equal(
    degradedEnrichmentDraft({ ...input, company: null, jobFunction: null, industry: null }).headline,
    'Анна Смирнова',
  );
  // Whitespace-only values count as unset (never rendered as blank rows).
  const blank = degradedEnrichmentDraft({ displayName: 'Bo', company: '  ', jobFunction: '', industry: '   ' });
  assert.deepEqual(blank, {
    headline: 'Bo',
    short_bio: null,
    company: null,
    links: [],
    suggested_interests: [],
    suggested_intents: [],
  });
});

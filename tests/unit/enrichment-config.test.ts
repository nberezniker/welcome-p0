import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  DEFAULT_GCP_LOCATION,
  DEFAULT_GCP_MODEL,
  DisabledEnrichmentProvider,
  ENRICHMENT_MAX_OUTPUT_TOKENS,
  buildSelfSignedJwt,
  enrichmentPrompt,
  extractJsonObject,
  extractSources,
  parseEnrichmentAnswer,
  parseServiceAccount,
  sanitizeSuggestions,
  selectEnrichmentProvider,
  selectTokenSource,
  VERTEX_AUDIENCE,
  VertexEnrichmentTransport,
  type EnrichmentProvider,
} from '../../src/integrations/enrichment';

// ---------------------------------------------------------------------------
// Provider selection matrix
// ---------------------------------------------------------------------------

test('enrichment provider: unset / unknown / vertex-without-credentials are disabled', async () => {
  for (const env of [{}, { ENRICHMENT_PROVIDER: '' }, { ENRICHMENT_PROVIDER: 'tavily' }]) {
    const provider = await selectEnrichmentProvider(env);
    assert.equal(provider.enabled, false);
    assert.ok(provider instanceof DisabledEnrichmentProvider);
  }

  // vertex without a project id → disabled (no half-configured provider)
  assert.equal((await selectEnrichmentProvider({ ENRICHMENT_PROVIDER: 'vertex' })).enabled, false);
  // vertex with a project but no credential → disabled
  assert.equal(
    (await selectEnrichmentProvider({ ENRICHMENT_PROVIDER: 'vertex', GCP_PROJECT_ID: 'p' })).enabled,
    false,
  );
  // vertex fully configured → the real transport, with env overrides honoured
  const provider = await selectEnrichmentProvider({
    ENRICHMENT_PROVIDER: 'vertex',
    GCP_PROJECT_ID: 'my-project',
    GCP_ACCESS_TOKEN: 'ya29.test-token',
  });
  assert.ok(provider instanceof VertexEnrichmentTransport);
  assert.equal(provider.enabled, true);
  assert.equal(provider.name, 'vertex_gemini');
  const defaults = await selectEnrichmentProvider({
    ENRICHMENT_PROVIDER: 'vertex-gemini',
    GCP_PROJECT_ID: 'my-project',
    GCP_ACCESS_TOKEN: 'ya29.test-token',
  });
  assert.ok(defaults instanceof VertexEnrichmentTransport);
  assert.equal(DEFAULT_GCP_MODEL, 'gemini-2.5-flash');
  assert.equal(DEFAULT_GCP_LOCATION, 'global');
});

test('enrichment provider: mock only outside production (CI tripwire)', async () => {
  const dev = await selectEnrichmentProvider({ ENRICHMENT_PROVIDER: 'mock', APP_ENV: 'development' });
  assert.equal(dev.enabled, true);
  assert.equal(dev.name, 'enrichment_mock');
  const testEnv = await selectEnrichmentProvider({ ENRICHMENT_PROVIDER: 'mock', APP_ENV: 'test' });
  assert.equal(testEnv.enabled, true);

  for (const appEnv of ['production']) {
    const prod = await selectEnrichmentProvider({ ENRICHMENT_PROVIDER: 'mock', APP_ENV: appEnv });
    assert.equal(prod.enabled, false, `mock must never be selectable when APP_ENV=${appEnv}`);
    assert.ok(prod instanceof DisabledEnrichmentProvider);
  }
});

test('disabled provider: honest 503 semantics, never a silent success', async () => {
  const provider: EnrichmentProvider = new DisabledEnrichmentProvider();
  const result = await provider.enrich({
    displayName: 'X',
    company: null,
    industry: null,
    links: [],
  });
  assert.equal(result.state, 'disabled');
  assert.equal(result.code, 'enrichment_disabled');
  assert.equal(result.retryable, false);
  assert.equal(result.draft, undefined);
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Real RSA key for the signing round-trip (generated once for this file). */
const RSA_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).privateKey.toString();

function saJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'p',
    client_email: 'sa@p.iam.gserviceaccount.com',
    private_key: RSA_KEY,
    ...overrides,
  });
}

test('credentials: GCP_ACCESS_TOKEN wins; SA JSON accepted raw and base64', () => {
  const fromToken = selectTokenSource({ GCP_ACCESS_TOKEN: 'ya29.token' });
  assert.equal(fromToken?.kind, 'gcp_access_token');

  const raw = parseServiceAccount(saJson());
  assert.equal(raw?.clientEmail, 'sa@p.iam.gserviceaccount.com');

  const b64 = Buffer.from(saJson(), 'utf8').toString('base64');
  assert.equal(parseServiceAccount(b64)?.clientEmail, 'sa@p.iam.gserviceaccount.com');
  assert.equal(selectTokenSource({ GCP_SA_JSON: b64 })?.kind, 'service_account_jwt');
  // alias used by the deploy secret file
  assert.equal(selectTokenSource({ GCP_SA_JSON_B64: b64 })?.kind, 'service_account_jwt');

  // unusable inputs
  assert.equal(parseServiceAccount('{}'), null);
  assert.equal(parseServiceAccount('not-base64-or-json'), null);
  assert.equal(parseServiceAccount(saJson({ private_key: 'nope' })), null);
  assert.equal(parseServiceAccount(''), null);
  assert.equal(parseServiceAccount(undefined), null);
  assert.equal(selectTokenSource({}), null);
});

test('credentials: self-signed JWT is RS256, well-claims-shaped and verifiable', async () => {
  const sa = parseServiceAccount(saJson())!;
  const now = 1_700_000_000;
  const jwt = buildSelfSignedJwt(sa, now);
  const [header, claims, signature] = jwt.split('.');
  assert.ok(header && claims && signature);

  const decodedHeader = JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'));
  assert.deepEqual(decodedHeader, { alg: 'RS256', typ: 'JWT' });
  const decodedClaims = JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8'));
  assert.equal(decodedClaims.iss, sa.clientEmail);
  assert.equal(decodedClaims.sub, sa.clientEmail);
  assert.equal(decodedClaims.aud, VERTEX_AUDIENCE);
  assert.equal(decodedClaims.iat, now);
  assert.equal(decodedClaims.exp, now + 3600);

  const ok = createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(sa.privateKey, Buffer.from(signature!, 'base64url'));
  assert.equal(ok, true, 'signature must verify against the service-account key');

  const source = selectTokenSource({ GCP_SA_JSON: saJson() })!;
  const minted = await source.getToken();
  const [mintedHeader, mintedClaims, mintedSignature] = minted.split('.');
  assert.equal(
    createVerify('RSA-SHA256')
      .update(`${mintedHeader}.${mintedClaims}`)
      .verify(sa.privateKey, Buffer.from(mintedSignature!, 'base64url')),
    true,
    'getToken() must return a verifiable self-signed assertion',
  );
});

// ---------------------------------------------------------------------------
// Prompt + answer parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Outbound request shape
// ---------------------------------------------------------------------------

test('vertex transport: thinking-model output budget, grounding tool, empty answer → no_draft', async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    // The healthy HTTP-200 answer that still carries NO visible text: the model
    // grounded, thought, and stopped without emitting an answer part (observed
    // live). The parser must call that a retryable failure, not a draft.
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '' }] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new VertexEnrichmentTransport({
      projectId: 'my-project',
      location: DEFAULT_GCP_LOCATION,
      model: DEFAULT_GCP_MODEL,
      tokenSource: { kind: 'gcp_access_token', getToken: async () => 'ya29.test-token' },
    });
    const result = await provider.enrich({
      displayName: 'Nikita B',
      company: '2AI',
      industry: 'ai-saas',
      links: ['https://2ai.com.ua'],
    });

    // An empty answer is a retryable failure, never a fake success.
    assert.equal(result.state, 'failed');
    assert.equal(result.code, 'no_draft');
    assert.equal(result.retryable, true);

    const call = calls[0];
    assert.ok(call, 'the transport must call fetch');
    assert.equal(
      call.url,
      'https://aiplatform.googleapis.com/v1/projects/my-project/locations/global/publishers/google/models/gemini-2.5-flash:generateContent',
    );
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers['x-goog-user-project'], 'my-project');
    assert.match(headers.authorization ?? '', /^Bearer /);

    const body = JSON.parse(String(call.init.body)) as {
      tools: unknown;
      generationConfig: { maxOutputTokens: number };
      contents: { parts: { text: string }[] }[];
    };
    assert.deepEqual(body.tools, [{ googleSearch: {} }], 'grounding must be requested');
    // gemini-2.5-flash charges its reasoning tokens against this same budget, so
    // the cap must stay well above the observed thought counts (up to ~2.9k).
    assert.ok(
      body.generationConfig.maxOutputTokens >= 2048,
      `maxOutputTokens must leave room for thinking tokens (got ${body.generationConfig.maxOutputTokens})`,
    );
    assert.equal(body.generationConfig.maxOutputTokens, ENRICHMENT_MAX_OUTPUT_TOKENS);
    assert.match(body.contents[0]!.parts[0]!.text, /Nikita B/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('prompt: own-profile-only rules, no third-party enrichment, JSON schema demanded', () => {
  const prompt = enrichmentPrompt({
    displayName: 'Анна Test',
    company: 'Acme',
    industry: 'ai-saas',
    links: ['https://example.com/anna'],
  });
  assert.match(prompt, /own profile only|ONLY|own data/i);
  assert.match(prompt, /never aggregate people|third person/i);
  assert.match(prompt, /Do not invent/i);
  assert.match(prompt, /SINGLE JSON object/);
  assert.match(prompt, /Анна Test/);
  assert.match(prompt, /https:\/\/example\.com\/anna/);
  assert.match(prompt, /\(no links provided\)|own links/);
  // when no links are given the placeholder is used
  assert.match(enrichmentPrompt({ displayName: 'X', company: null, industry: null, links: [] }), /\(no links provided\)/);
});

test('answer parsing: tolerates fences/prose, sanitizes catalogue ids and links', () => {
  const answer = [
    'Here is the draft:',
    '```json',
    JSON.stringify({
      headline: 'Founder at Acme',
      short_bio: 'Building things.',
      company: 'Acme',
      links: ['https://acme.example', 'javascript:alert(1)', 'not-a-url', 'https://acme.example'],
      suggested_interests: ['ai-ml', 'not-a-real-interest', 'Стартапы'],
      suggested_intents: ['seeking-cofounder', 'open-to-cofound', 'made-up-intent'],
    }),
    '```',
  ].join('\n');

  const parsed = parseEnrichmentAnswer(answer, [{ title: 'Src', uri: 'https://src.example' }]);
  assert.ok(parsed);
  assert.equal(parsed!.draft.headline, 'Founder at Acme');
  assert.deepEqual(parsed!.draft.links, ['https://acme.example'], 'non-http and duplicate links are dropped');
  assert.deepEqual(parsed!.draft.suggested_interests, ['ai-ml', 'startups'], 'unknown ids dropped, aliases normalized');
  assert.deepEqual(parsed!.draft.suggested_intents, ['seeking-cofounder', 'open-to-cofound']);
  assert.equal(parsed!.sources.length, 1);

  assert.equal(extractJsonObject('no json here'), null);
  assert.equal(extractJsonObject('{ broken'), null);
  assert.equal(extractJsonObject('[1,2,3]'), null);
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });

  // an answer with nothing usable is not a draft
  assert.equal(parseEnrichmentAnswer('{"headline":null,"short_bio":null,"company":null,"links":[],"suggested_interests":[],"suggested_intents":[]}', []), null);
});

test('answer parsing: suggestion caps and grounding sources', () => {
  const suggestions = sanitizeSuggestions({
    suggested_interests: ['ai-ml', 'saas', 'dev-tools', 'automation', 'data-analytics', 'cybersecurity', 'climate'],
    suggested_intents: ['seeking-cofounder', 'seeking-clients', 'seeking-partner', 'seeking-team', 'open-to-cofound', 'investing'],
  });
  assert.equal(suggestions.suggested_interests.length, 5, 'capped at MAX_INTERESTS');
  assert.deepEqual(suggestions.suggested_interests, ['ai-ml', 'saas', 'dev-tools', 'automation', 'data-analytics']);
  assert.equal(suggestions.suggested_intents.filter((id) => id.startsWith('seeking-')).length, 3, 'max 3 needs');
  assert.ok(suggestions.suggested_intents.includes('open-to-cofound'));
  assert.ok(suggestions.suggested_intents.includes('investing'));
  assert.equal(suggestions.suggested_intents.length, 5);

  const sources = extractSources({
    candidates: [
      {
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://a.example', title: 'A' } },
            { web: { uri: 'https://a.example', title: 'A dup' } },
            { web: { uri: 'https://b.example' } },
            { web: {} },
          ],
        },
      },
    ],
  });
  assert.deepEqual(sources, [
    { title: 'A', uri: 'https://a.example' },
    { title: 'https://b.example', uri: 'https://b.example' },
  ]);
  assert.deepEqual(extractSources({}), []);
});

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { clientIp, consumeIpToken, type TokenVerdict } from './ratelimit';
import { appEnv, type AppEnv } from './env';
import { log } from './logger';
import { REQUEST_ID_HEADER, newRequestId } from './request-id';
import { currentRequestId, requestIdFor, runWithRequestId } from './request-context';

/** Unified JSON error model: {code, message, correlation_id, retryable}.
 * Never include SQL, stack traces or secrets in the payload. */

export interface JsonHeaders {
  headers?: Record<string, string>;
}

/**
 * F-08: explicit cache discipline for AUTHENTICATED responses. Platform
 * defaults (`public, max-age=0`) let shared caches store private payloads;
 * every authed GET must set `no-store, private` explicitly. The event-view
 * helper (src/lib/event-view.ts) carries the same directive.
 */
export function privateCacheHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store, private' };
}

export function jsonOk(data: Record<string, unknown>, init?: { status?: number } & JsonHeaders): NextResponse {
  return NextResponse.json(data, { status: init?.status ?? 200, headers: init?.headers });
}

/**
 * The one error-response builder, and the one place an error response is LOGGED.
 *
 * WHY THE ID IS RESOLVED HERE. `correlation_id` used to be a fresh uuid per
 * ERROR RESPONSE, which made it a property of a body rather than of a request:
 * two errors in one request carried two different ids, and no other log line of
 * that request could carry it at all. It now comes from the ambient request
 * context (src/lib/request-context.ts) — the same value that src/proxy.ts puts
 * in the `x-request-id` header and that `withRequestContext` returns on the
 * response. Only when there is no request behind the call (a worker tick, a
 * script) is a fresh id minted, and then it is still the id of this response's
 * log line, so the promise "the body's id finds the log line" holds either way.
 *
 * WHY THIS FUNCTION LOGS. The id is only useful if a user's report ("it said
 * correlation_id 4f2c…") can be found in the logs, and every error response in
 * this app is built here — 4xx included. Narrowing this to 5xx would leave a
 * reported 409/429/403 untraceable, which is the case that actually needs
 * tracing, since it is the one a user can describe. The level follows the
 * severity (`error` for 5xx, `warn` for 4xx) so a 5xx can still be alerted on
 * without excluding the rest from the log.
 *
 * `init.err` carries a caught value into that same line: it exists so
 * `internalError` can hand over the cause and have ONE line, with the stack,
 * bearing the id — rather than a summary line plus a second line without it.
 */
export function jsonError(
  status: number,
  code: string,
  message: string,
  init?: { retryable?: boolean; correlationId?: string; err?: unknown } & JsonHeaders,
): NextResponse {
  const retryable = init?.retryable ?? false;
  const correlationId = init?.correlationId ?? currentRequestId() ?? newRequestId();
  const fields = { event: 'api_error_response', correlation_id: correlationId, code, status, retryable };
  if (status >= 500) log.error('[api] error response', { ...fields, err: init?.err });
  else log.warn('[api] error response', fields);

  return NextResponse.json(
    { code, message, correlation_id: correlationId, retryable },
    { status, headers: init?.headers },
  );
}

/** Safe body reader — malformed JSON becomes `undefined`, handled by validation. */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/**
 * Logs an unexpected error server-side and returns a sanitized 500 response.
 *
 * The id is NOT minted here any more. It comes from the ambient request context
 * through `jsonError`, which also owns the log line — so this 500 produces
 * exactly ONE record, and that record carries the same id the caller receives.
 * The previous shape produced the id here, logged with it, and passed it down;
 * that worked for this one path and left every other error response (4xx, the
 * CSRF 403, the rate-limit 429) with an id that appeared in the body and
 * nowhere else.
 *
 * The cause stays server-side either way: the response carries a generic
 * message, and the stack is written to the log, not to it.
 */
export function internalError(err: unknown): NextResponse {
  return jsonError(500, 'internal_error', 'Unexpected error. Please retry later.', {
    retryable: true,
    err,
  });
}

/** Basic string field validators shared by route handlers. */
export function asString(value: unknown, opts?: { maxLength?: number; minLength?: number }): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  const min = opts?.minLength ?? 1;
  if (v.length < min) return null;
  if (opts?.maxLength !== undefined && v.length > opts.maxLength) return null;
  return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v.length < 3 || v.length > 320 || !EMAIL_RE.test(v)) return null;
  return v;
}

// ---------------------------------------------------------------------------
// CSRF: same-origin enforcement for mutating requests (Phase 5 hardening).
// Logic lives here once; every mutating handler is exported through `withApi`.
// ---------------------------------------------------------------------------

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Lowercases and strips default ports so `https://x` matches Host `x:443`. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/:(80|443)$/, '');
}

/**
 * Same-origin decision for one request:
 *  - Origin absent → allow unless Sec-Fetch-Site claims 'cross-site'
 *    (curl/webhook-style server-to-server calls pass);
 *  - Origin `null` (sandboxed iframe etc.) → reject;
 *  - Origin present → its host must equal Host / X-Forwarded-Host.
 */
export function isSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (!origin) {
    return req.headers.get('sec-fetch-site') !== 'cross-site';
  }
  if (origin === 'null') return false;
  let originHost: string;
  try {
    originHost = normalizeHost(new URL(origin).host);
  } catch {
    return false;
  }
  if (!originHost) return false;
  const forwarded = req.headers.get('x-forwarded-host');
  const host = (forwarded ? (forwarded.split(',')[0]?.trim() ?? '') : (req.headers.get('host') ?? ''));
  if (!host) return false;
  return originHost === normalizeHost(host);
}

/** Returns a 403 for a cross-site mutating request, else null. */
export function csrfGuard(req: NextRequest): NextResponse | null {
  if (!MUTATING_METHODS.has(req.method)) return null;
  if (isSameOrigin(req)) return null;
  return jsonError(403, 'csrf_origin', 'Cross-origin request rejected');
}

// ---------------------------------------------------------------------------
// Generic per-IP rate limiting for sensitive routes (Phase 5 hardening).
// Token buckets are in-memory and single-process (documented limitation,
// ADR 0005); DB-level per-subject throttles stay in place alongside.
// ---------------------------------------------------------------------------

/**
 * Capacity may be a function when the limit is configurable. Exactly ONE rule is
 * configurable today — the OTP bucket — and only to make it LARGER in a
 * non-production environment (ADR-style knob for e2e/load runs, where dozens of
 * sign-ins happen inside the same minute and the per-IP bucket, not the product,
 * becomes the bottleneck). It can never be lowered, and it is ignored entirely
 * when APP_ENV=production: a rate limit is a security control, so an env
 * variable must not be able to weaken it in production.
 */
interface IpRateRule {
  key: string;
  pattern: RegExp;
  capacity: number | (() => number);
  windowMs: number;
}

/** Default OTP capacity, and the only value production can ever use. */
export const OTP_RATE_CAPACITY = 10;

/**
 * OTP capacity for the current environment. `RATE_LIMIT_OTP_CAPACITY` raises it
 * for e2e/load runs; values below the default (or unparsable ones) are ignored.
 */
export function otpRateCapacity(env: AppEnv = appEnv(), raw: string | undefined = process.env.RATE_LIMIT_OTP_CAPACITY): number {
  if (env === 'production') return OTP_RATE_CAPACITY;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= OTP_RATE_CAPACITY) return OTP_RATE_CAPACITY;
  return Math.min(Math.floor(parsed), 1000);
}

const IP_RATE_RULES: IpRateRule[] = [
  { key: 'otp_request', pattern: /^\/api\/auth\/otp\/request$/, capacity: () => otpRateCapacity(), windowMs: 60_000 },
  { key: 'otp_verify', pattern: /^\/api\/auth\/otp\/verify$/, capacity: () => otpRateCapacity(), windowMs: 60_000 },
  // F-02: join_code brute-force surface — 10 joins/min/IP on top of the DB-level
  // per-(event, ip) failed-attempt lock enforced inside the route itself.
  { key: 'event_join', pattern: /^\/api\/events\/[^/]+\/join$/, capacity: 10, windowMs: 60_000 },
  { key: 'registration_claims', pattern: /^\/api\/registration-claims$/, capacity: 30, windowMs: 60_000 },
  { key: 'reports', pattern: /^\/api\/reports$/, capacity: 30, windowMs: 60_000 },
  { key: 'blocks', pattern: /^\/api\/blocks(\/|$)/, capacity: 30, windowMs: 60_000 },
  // F-03: MFA surface — enroll/manage are cheap but sensitive; the step-up
  // verify additionally carries the DB-level per-account 5/15min lock.
  { key: 'mfa_enroll', pattern: /^\/api\/me\/mfa\/totp$/, capacity: 10, windowMs: 60_000 },
  { key: 'mfa_manage', pattern: /^\/api\/me\/mfa(\/|$)/, capacity: 10, windowMs: 60_000 },
  { key: 'mfa_verify', pattern: /^\/api\/auth\/mfa\/verify$/, capacity: 10, windowMs: 60_000 },
];

function rateLimitHeaders(verdict: TokenVerdict, capacity: number): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(capacity),
    'X-RateLimit-Remaining': String(verdict.remaining),
    'X-RateLimit-Reset': String(Math.ceil((verdict.nowMs + verdict.retryAfterMs) / 1000)),
  };
}

export interface RouteContext<P> {
  params: Promise<P>;
}

/**
 * Runs one route handler inside its request scope, and stamps the id on the way
 * out. Two effects, one reason:
 *
 *   1. `runWithRequestId` makes the id ambient, so every log line and error body
 *      produced anywhere beneath the handler carries it without a single call
 *      site passing it (`jsonError`, `internalError`, `enqueueOutbox`);
 *   2. the `x-request-id` response header carries it back on EVERY response —
 *      including 2xx, where there is no body field to hold it — so a caller
 *      reporting a problem can quote something the server recognises even when
 *      nothing failed on the wire.
 *
 * The id itself is settled once, in src/proxy.ts (well-formed inbound header
 * reused, anything else replaced) and re-derived here for the paths where the
 * proxy did not run — a direct handler invocation in a test, or a route outside
 * the proxy matcher. `requestIdFor` implements exactly that rule, so the two
 * layers cannot disagree.
 *
 * The REQUEST is optional in the returned type, for a reason that is about
 * shapes rather than convenience: three routes in this app take no request at
 * all (`GET()` on /api/taxonomy, /api/providers, /api/auth/demo-login-info), and
 * their tests call them that way. Next always passes one, but a handler that
 * ignores it has nothing to read an id from, so the honest result is a fresh one
 * — an id that joins that call's log lines to each other and to nothing else.
 *
 * This is BEHAVIOUR-NEUTRAL: unlike `withApi` it adds no CSRF check and no rate
 * limit. It exists so a route can have a request scope without also acquiring
 * guards it was deliberately not given.
 */
export function withRequestContext<P = Record<string, string>>(
  handler: (req: NextRequest, ctx: RouteContext<P>) => Promise<Response>,
): (req?: NextRequest, ctx?: RouteContext<P>) => Promise<Response> {
  return async (req, ctx) => {
    const requestId = req ? requestIdFor(req) : newRequestId();
    return runWithRequestId(requestId, async () => {
      const res = await handler(req as NextRequest, ctx as RouteContext<P>);
      res.headers.set(REQUEST_ID_HEADER, requestId);
      return res;
    });
  };
}

/**
 * Wraps a route handler with the shared mutation guards: the CSRF origin check
 * (effective on POST/PATCH/PUT/DELETE) and the per-IP rate limit when the
 * request path is on the sensitive-route table. ALL mutating handlers must be
 * exported through this wrapper — no guard logic in individual routes.
 *
 * The guards run INSIDE the request scope (see `withRequestContext`), which is
 * the order that matters for tracing: a rejected request — the CSRF 403 or the
 * rate-limit 429 — is exactly the kind of error a user reports, and it now
 * carries the same id in its body, its header, and its log line as any other
 * response of that request.
 *
 * The input type requires the context (param-bearing handlers keep their exact
 * signature); the returned type makes it optional so 1-arg call sites (routes
 * without params and their tests) stay valid — Next.js always supplies it.
 */
export function withApi<P = Record<string, string>>(
  handler: (req: NextRequest, ctx: RouteContext<P>) => Promise<Response>,
): (req: NextRequest, ctx?: RouteContext<P>) => Promise<Response> {
  return withRequestContext<P>(async (req, ctx) => {
    const csrf = csrfGuard(req);
    if (csrf) return csrf;

    const path = req.nextUrl.pathname;
    const rule = IP_RATE_RULES.find((r) => r.pattern.test(path));
    if (!rule) return handler(req, ctx as RouteContext<P>);

    const capacity = typeof rule.capacity === 'function' ? rule.capacity() : rule.capacity;
    const verdict = consumeIpToken(clientIp(req), rule.key, {
      capacity,
      windowMs: rule.windowMs,
    });
    const headers = rateLimitHeaders(verdict, capacity);
    if (!verdict.allowed) {
      return jsonError(429, 'rate_limited', 'Too many requests. Slow down and try again later.', {
        retryable: true,
        headers: { ...headers, 'Retry-After': String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))) },
      });
    }
    const res = await handler(req, ctx as RouteContext<P>);
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  });
}

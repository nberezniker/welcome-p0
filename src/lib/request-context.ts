import { AsyncLocalStorage } from 'node:async_hooks';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id';

/**
 * The request id, ambient for the duration of one request.
 *
 * WHY `AsyncLocalStorage` AND NOT A PARAMETER. The id has to reach code that has
 * no request in hand: `jsonError` (≈270 call sites, none of which pass one),
 * `internalError`, and `enqueueOutbox` deep inside a business transaction. An
 * ambient context is what makes the guarantee STRUCTURAL rather than a
 * convention each new call site has to remember — and it is the only mechanism
 * that survives `await` boundaries without threading an argument through every
 * intermediate function.
 *
 * WHY THIS MODULE IS SERVER-ONLY. `node:async_hooks` does not exist in the
 * browser or the edge runtime, so nothing that a client component imports may
 * reach it. src/lib/http.ts (the only importer) is server-side, and src/proxy.ts
 * keeps using the dependency-free src/lib/request-id.ts for header
 * normalisation precisely so the edge graph never pulls this in.
 *
 * The value is never derived from anything else in the request: it comes from the
 * validated header or from a fresh uuid (see src/lib/request-id.ts).
 */
const storage = new AsyncLocalStorage<string>();

/**
 * Runs `fn` with `id` as the current request id. Every log line and error body
 * produced inside — including in code called many frames deeper — carries it.
 */
export function runWithRequestId<T>(id: string, fn: () => T): T {
  return storage.run(id, fn);
}

/**
 * The id of the request being served, or `undefined` outside one (a worker tick,
 * a script, a unit test). `undefined` is meaningful rather than a gap: it is why
 * an outbox job enqueued by the WORKER gets a NULL `correlation_id` instead of a
 * fabricated one.
 */
export function currentRequestId(): string | undefined {
  return storage.getStore();
}

/**
 * The id for `req`: its own well-formed header (set by src/proxy.ts, or supplied
 * directly by a test/another service), otherwise a fresh one.
 *
 * Callers that get an id this way and need it to be AMBIENT should use
 * `runWithRequestId` — see `withRequestContext` in src/lib/http.ts, which does
 * both and is what every route goes through.
 */
export function requestIdFor(req: { headers: Headers }): string {
  return resolveRequestId(req.headers.get(REQUEST_ID_HEADER));
}

export { REQUEST_ID_HEADER };

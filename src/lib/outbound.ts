/**
 * What every outbound HTTP call in this app shares: one shaped transport
 * function, one bound, and one honest label for "we cut it off".
 *
 * WHY A MODULE. Four providers are called — Resend (email), the Telegram Bot
 * API, Google (OAuth token/revoke + People + Calendar) and Vertex AI
 * (enrichment) — and each keeps its own outcome vocabulary, because "failed"
 * means something different when Telegram refuses your token than when a
 * grounded model returns an unparsable answer. What must NOT be a per-site
 * decision is the BOUND: an outbound call with no deadline holds a request, or a
 * worker tick, forever, and that is a property of the whole app rather than of
 * one provider. Centralising the mechanism makes an unbounded call a thing you
 * have to work at writing.
 *
 * The per-provider BUDGETS are deliberately different (10s for a message, a 30s
 * wall-clock deadline for a grounded model call) and stay next to the transport
 * that owns them, documented there — a shared constant would invite tuning one
 * provider by editing another's number.
 */

/** A fetch with the same shape as the global one — the seam every transport takes. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Options every transport accepts, for tests only.
 *
 * WHY BOTH FIELDS EXIST. A test that wants to prove "this call is bounded, and a
 * timeout becomes this typed failure" has to be able to (a) hang the request and
 * (b) not wait the real budget doing it. Injecting the transport function covers
 * (a) without monkey-patching `globalThis.fetch` (which would affect unrelated
 * code running in the same process), and injecting the timeout covers (b).
 * Production never passes either: `selectTransport`/`selectNotificationEmail
 * Transport`/`selectEnrichmentProvider` construct these with the default budget
 * and the real fetch, and there is no environment variable that can change it —
 * a timeout is a safety control, not a preference.
 */
export interface OutboundTransportOptions {
  /** The HTTP transport. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Per-call bound in ms. Defaults to the transport's own documented budget. */
  timeoutMs?: number;
}

/** The default: the global fetch, wrapped so `this.fetchImpl` is always callable. */
export function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

/**
 * True when the request was cut off by its OWN timeout.
 *
 * `AbortSignal.timeout` rejects with a `DOMException` named `TimeoutError`
 * (verified on this runtime: a connection that never answers rejects with
 * `TimeoutError`, while a refused connection rejects with a plain `TypeError` —
 * which is why the transports can, and do, tell the two apart). `AbortError` is
 * deliberately NOT folded in here: nothing in this app aborts these signals
 * except the timeout, so accepting it would only hide a future
 * caller-supplied signal behind a lie.
 */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/**
 * A deadline signal for one call. TOTAL by construction: a non-positive or
 * non-numeric budget becomes the smallest real delay instead of propagating.
 *
 * WHY THAT MATTERS (a real defect this replaces): `AbortSignal.timeout(-5)`
 * throws a `RangeError` immediately. Called from inside a transport's `try`, that
 * exception is caught by the same handler that classifies transport failures —
 * and because its name is not `TimeoutError`, an exhausted budget was reported as
 * `network_error`, i.e. blamed on the network. A caller that has spent its
 * deadline must report a TIMEOUT (see the enrichment transport's guard); this
 * function exists so that no call shape can produce the RangeError at all.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const bounded = Number.isFinite(ms) ? Math.floor(ms) : 0;
  return AbortSignal.timeout(bounded > 0 ? bounded : 1);
}

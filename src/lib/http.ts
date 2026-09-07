import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

/** Unified JSON error model: {code, message, correlation_id, retryable}.
 * Never include SQL, stack traces or secrets in the payload. */

export interface JsonHeaders {
  headers?: Record<string, string>;
}

export function jsonOk(data: Record<string, unknown>, init?: { status?: number } & JsonHeaders): NextResponse {
  return NextResponse.json(data, { status: init?.status ?? 200, headers: init?.headers });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  init?: { retryable?: boolean; correlationId?: string } & JsonHeaders,
): NextResponse {
  return NextResponse.json(
    {
      code,
      message,
      correlation_id: init?.correlationId ?? randomUUID(),
      retryable: init?.retryable ?? false,
    },
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

/** Logs an unexpected error server-side and returns a sanitized 500 response. */
export function internalError(err: unknown): NextResponse {
  const correlationId = randomUUID();
  console.error(`[internal_error] correlation_id=${correlationId}`, err);
  return jsonError(500, 'internal_error', 'Unexpected error. Please retry later.', {
    retryable: true,
    correlationId,
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

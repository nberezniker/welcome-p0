import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { extractSessionCookie } from '../../src/lib/auth';

export interface RouteResponseLike {
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: Headers;
}

/** Builds a NextRequest like the Next.js server would for a route handler. */
export function makeRequest(
  url: string,
  init?: { method?: string; body?: unknown; cookie?: string },
): NextRequest {
  const method = init?.method ?? (init?.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  if (init?.cookie) headers['cookie'] = init.cookie;
  return new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@integration.test`;
}

/** Full login: request OTP (dev-exposed), verify, return the cookie header value. */
export async function loginViaOtp(
  requestOtp: (req: NextRequest) => Promise<Response>,
  verifyOtp: (req: NextRequest) => Promise<Response>,
  email: string,
): Promise<string> {
  const reqRes = await requestOtp(makeRequest('/api/auth/otp/request', { body: { email } }));
  assertStatus(reqRes, 200);
  const body = (await reqRes.json()) as { ok: boolean; devCode?: string };
  if (!body.devCode) throw new Error('devCode missing — AUTH_DEV_EXPOSE_OTP must be true in integration env');
  const verifyRes = await verifyOtp(makeRequest('/api/auth/otp/verify', { body: { email, code: body.devCode } }));
  assertStatus(verifyRes, 200);
  const setCookie = verifyRes.headers.getSetCookie()[0] ?? null;
  const token = extractSessionCookie(setCookie);
  if (!token) throw new Error('welcome_session cookie was not set on verify response');
  return `welcome_session=${token}`;
}

export function assertStatus(res: Response, expected: number): void {
  if (res.status !== expected) {
    throw new Error(`expected status ${expected}, got ${res.status}`);
  }
}

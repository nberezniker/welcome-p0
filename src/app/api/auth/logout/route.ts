import { NextRequest } from 'next/server';
import { clearSessionCookie, destroySession, SESSION_COOKIE } from '../../../../lib/auth';
import { jsonOk, internalError } from '../../../../lib/http';

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (token) {
      await destroySession(token);
    }
    const res = jsonOk({ ok: true });
    clearSessionCookie(res);
    return res;
  } catch (err) {
    return internalError(err);
  }
}

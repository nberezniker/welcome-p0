'use client';

import { useState } from 'react';

/** Claim confirmation button for /claim/[token]. The token is spent only by
 * this POST — never by opening the page. */
export default function ClaimButton({ token }: { token: string }) {
  const [state, setState] = useState<'idle' | 'claiming' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function claim() {
    setState('claiming');
    setMessage(null);
    try {
      const res = await fetch('/api/registration-claims', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        const body = (await res.json()) as { notice: string };
        setNotice(body.notice);
        setState('done');
        return;
      }
      const err = (await res.json().catch(() => null)) as { code?: string } | null;
      setState('error');
      if (res.status === 401) setMessage('Войдите в аккаунт, привязанный к этому email, и повторите.');
      else if (err?.code === 'email_mismatch') setMessage('Эта ссылка выдана для другого email.');
      else if (err?.code === 'already_used') setMessage('Ссылка уже использована.');
      else if (err?.code === 'expired') setMessage('Срок действия ссылки истёк.');
      else if (err?.code === 'claim_not_allowed') setMessage('Эта регистрация не может быть подтверждена.');
      else setMessage('Не удалось подтвердить участие. Попробуйте позже.');
    } catch {
      setState('error');
      setMessage('Сеть недоступна. Попробуйте позже.');
    }
  }

  if (state === 'done') {
    return (
      <div className="mt-6 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        <p className="font-medium">Участие подтверждено.</p>
        {notice && <p className="mt-1">{notice}</p>}
        <a href="/me" className="mt-2 inline-block font-medium underline">Перейти в профиль</a>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={claim}
        disabled={state === 'claiming'}
        className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
      >
        {state === 'claiming' ? 'Подтверждаем…' : 'Подтвердить участие'}
      </button>
      {message && <p className="mt-2 text-sm text-red-700">{message}</p>}
    </div>
  );
}

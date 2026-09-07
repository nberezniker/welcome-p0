'use client';

import { useState } from 'react';

/** Client-side join affordance for /e/[slug]. Surfaces the API error model
 * without leaking internals; profile_required points the user at their profile. */
export default function JoinEventButton({ eventId }: { eventId: string }) {
  const [state, setState] = useState<'idle' | 'joining' | 'joined' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function join() {
    setState('joining');
    setMessage(null);
    try {
      const res = await fetch(`/api/events/${eventId}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        setState('joined');
        return;
      }
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      setState('error');
      if (body?.code === 'profile_required') {
        setMessage('Сначала создайте профиль — затем вернитесь сюда.');
      } else if (body?.code === 'event_full') {
        setMessage('Мероприятие достигло лимита участников.');
      } else if (body?.code === 'join_forbidden') {
        setMessage('Нужен код приглашения или подтверждённая регистрация.');
      } else if (body?.code === 'event_not_active') {
        setMessage('Мероприятие пока не открыто.');
      } else if (res.status === 401) {
        setMessage('Войдите, чтобы участвовать.');
      } else {
        setMessage('Не удалось присоединиться. Попробуйте позже.');
      }
    } catch {
      setState('error');
      setMessage('Сеть недоступна. Попробуйте позже.');
    }
  }

  if (state === 'joined') {
    return <p className="mt-6 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">Вы участвуете. Организатор увидит вас в списке.</p>;
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={join}
        disabled={state === 'joining'}
        className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
      >
        {state === 'joining' ? 'Присоединяем…' : 'Участвовать'}
      </button>
      {message && <p className="mt-2 text-sm text-red-700">{message}</p>}
    </div>
  );
}

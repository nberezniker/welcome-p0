import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getSql } from '../../../lib/db';
import { getAccountIdByToken, SESSION_COOKIE } from '../../../lib/auth';
import { loadClaimPreview } from '../../../lib/claim';
import ClaimButton from './claim-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Подтверждение участия',
  robots: { index: false, follow: false },
};

/** GET /claim/[token] — read-only preview (AC-07): shows only the event name,
 * never the imported dossier, and NEVER consumes the challenge. The claim
 * itself happens via POST /api/registration-claims from the matching account. */
export default async function ClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const preview = await loadClaimPreview(getSql(), token);

  if (!preview) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-14">
        <article className="rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-semibold">Ссылка недействительна</h1>
          <p className="mt-2 text-neutral-600">
            Проверьте ссылку из письма или попросите организатора новую.
          </p>
        </article>
      </main>
    );
  }

  const jar = await cookies();
  const token2 = jar.get(SESSION_COOKIE)?.value ?? null;
  const accountId = await getAccountIdByToken(token2);

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-14">
      <article className="rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Приглашение</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{preview.event.name}</h1>
        {preview.organizerName && <p className="mt-1 text-neutral-500">Организатор: {preview.organizerName}</p>}

        {preview.alreadyClaimed ? (
          <p className="mt-6 rounded-xl bg-neutral-100 px-4 py-3 text-sm text-neutral-700">
            Эта ссылка уже использована.
          </p>
        ) : preview.expired ? (
          <p className="mt-6 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Срок действия ссылки истёк. Попросите организатора новую.
          </p>
        ) : accountId ? (
          <>
            <p className="mt-4 text-neutral-700">
              Подтвердите участие — данные из регистрации можно будет проверить и поправить в профиле.
            </p>
            <ClaimButton token={token} />
          </>
        ) : (
          <p className="mt-6 rounded-xl bg-neutral-100 px-4 py-3 text-sm text-neutral-700">
            Войдите в аккаунт с email, указанным при регистрации, чтобы подтвердить участие.
          </p>
        )}
      </article>
    </main>
  );
}

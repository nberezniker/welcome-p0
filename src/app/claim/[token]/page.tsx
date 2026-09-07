import type { Metadata } from 'next';
import Link from 'next/link';
import { getT } from '../../../i18n';
import { getSql } from '../../../lib/db';
import { getOptionalAccountId } from '../../../lib/session-page';
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
  const { t } = await getT();
  const preview = await loadClaimPreview(getSql(), token);

  if (!preview) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-14">
        <div className="card">
          <h1 className="text-2xl font-extrabold tracking-tight">{t('claim.title')}</h1>
          <p className="mt-2 text-sm text-muted">{t('claim.invalid')}</p>
          <Link href="/" className="btn-light btn-small mt-4">
            {t('common.backToHome')}
          </Link>
        </div>
      </main>
    );
  }

  const accountId = await getOptionalAccountId();

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-14">
      <div className="card">
        <p className="text-xs font-bold uppercase tracking-wide text-muted">{t('claim.subtitle')}</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">{preview.event.name}</h1>
        {preview.organizerName && (
          <p className="mt-1 text-sm text-muted">
            {t('claim.organizerLabel')}: {preview.organizerName}
          </p>
        )}

        {preview.alreadyClaimed ? (
          <p className="mt-6 rounded-xl bg-paper px-4 py-3 text-sm text-ink" data-testid="claim-used">
            {t('claim.used')}
          </p>
        ) : preview.expired ? (
          <p className="mt-6 rounded-xl bg-accent-pale px-4 py-3 text-sm text-accent" data-testid="claim-expired">
            {t('claim.expired')}
          </p>
        ) : accountId ? (
          <>
            <ClaimButton
              token={token}
              eventId={null}
              strings={{
                claimCta: t('claim.claimCta'),
                claiming: t('claim.claiming'),
                done: t('claim.done'),
                notice: t('claim.notice'),
                dataNote: t('claim.dataNote'),
                setupTitle: t('claim.setupTitle'),
                setupTags: t('claim.setupTags'),
                setupVisibility: t('claim.setupVisibility'),
                openProfile: t('claim.openProfile'),
                openEvent: t('claim.openEvent'),
                openMe: t('claim.openMe'),
                signInToRetry: t('claim.signInPrompt'),
                emailMismatch: t('claim.signInPrompt'),
                alreadyUsed: t('claim.used'),
                expired: t('claim.expired'),
                notAllowed: t('claim.expired'),
                errorGeneric: t('common.errorGeneric'),
                errorNetwork: t('common.errorNetwork'),
              }}
            />
          </>
        ) : (
          <div className="mt-6 rounded-xl bg-paper px-4 py-3 text-sm text-ink" data-testid="claim-signin-prompt">
            <p>{t('claim.signInPrompt')}</p>
            <Link href="/login" className="btn-primary btn-small mt-3" data-testid="claim-signin">
              {t('claim.signInCta')}
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}

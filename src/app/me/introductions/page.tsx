import type { Metadata } from 'next';
import { getSql } from '../../../lib/db';
import { requireAccountId } from '../../../lib/session-page';
import { getT } from '../../../i18n';
import { IntroCard, type ContactKind } from './intro-card';

export const metadata: Metadata = { title: 'Знакомства', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

interface IntroListItem {
  id: string;
  state: string;
  other_name: string;
  other_account_id: string;
}

export default async function IntroductionsPage() {
  const accountId = await requireAccountId('/me/introductions');
  const { t } = await getT();
  const sql = getSql();

  const myRows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId} LIMIT 1`;
  const myProfileId = myRows[0]?.id;
  let intros: IntroListItem[] = [];
  if (myProfileId) {
    intros = await sql<IntroListItem[]>`
      SELECT i.id, i.state,
        CASE WHEN i.profile_a = ${myProfileId} THEN pb.display_name ELSE pa.display_name END AS other_name,
        CASE WHEN i.profile_a = ${myProfileId} THEN pb.account_id ELSE pa.account_id END AS other_account_id
      FROM introductions i
      JOIN profiles pa ON pa.id = i.profile_a
      JOIN profiles pb ON pb.id = i.profile_b
      WHERE (i.profile_a = ${myProfileId} OR i.profile_b = ${myProfileId})
        AND i.state IN ('pending', 'mutual', 'declined', 'revoked')
      ORDER BY i.created_at DESC
      LIMIT 100`;
  }

  const kindLabels: Record<ContactKind, string> = {
    whatsapp: t('contacts.kind.whatsapp'),
    telegram_username: t('contacts.kind.telegram_username'),
    linkedin_url: t('contacts.kind.linkedin_url'),
    website: t('contacts.kind.website'),
    phone: t('contacts.kind.phone'),
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{t('intros.title')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('intros.subtitle')}</p>
      <div className="mt-6 flex flex-col gap-4">
        {intros.length === 0 ? <p className="text-sm text-muted">{t('intros.empty')}</p> : null}
        {intros.map((intro) => (
          <IntroCard
            key={intro.id}
            introId={intro.id}
            otherName={intro.other_name}
            otherAccountId={intro.other_account_id}
            kindLabels={kindLabels}
            strings={{
              stateLabels: {
                pending: t('intros.state.pending'),
                mutual: t('intros.state.mutual'),
                declined: t('intros.state.declined'),
                revoked: t('intros.state.revoked'),
              },
              otherPending: (name) => t('intros.otherPending', { name }),
              waitingForYou: t('intros.waitingForYou'),
              accept: t('intros.accept'),
              decline: t('intros.decline'),
              withdraw: t('intros.withdraw'),
              revealFieldsLabel: t('intros.revealFieldsLabel'),
              revealNone: t('intros.revealNone'),
              responded: t('intros.responded'),
              report: t('intros.report'),
              block: t('intros.block'),
              reportDone: t('intros.reportDone'),
              blockDone: t('intros.blockDone'),
              declineNote: t('intros.declineNote'),
              mutualNote: t('intros.mutualNote'),
              decisionLabels: {
                pending: t('intros.decisionPending'),
                accept: t('intros.decisionAccepted'),
                decline: t('intros.decisionDeclined'),
                withdraw: t('intros.decisionWithdrawn'),
              },
              revealedFrom: (name) => t('intros.revealedFrom', { name }),
              reportModalTitle: t('intros.report'),
              reportReasonLabel: t('intros.report'),
              reportDetailsLabel: t('intros.reportDetails'),
              reportSubmit: t('common.confirm'),
              cancel: t('common.cancel'),
              loading: t('common.loading'),
              errorNetwork: t('common.errorNetwork'),
              errorGeneric: t('common.errorGeneric'),
            }}
          />
        ))}
      </div>
    </div>
  );
}

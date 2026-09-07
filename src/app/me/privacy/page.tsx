import type { Metadata } from 'next';
import { getSql } from '../../../lib/db';
import { requireAccountId } from '../../../lib/session-page';
import { getT, POLICY_VERSION, type DictKey } from '../../../i18n';
import { PrivacyPanel, CONSENT_PURPOSES_UI, type ConsentToggleRow } from './privacy-panel';

export const metadata: Metadata = { title: 'Приватность', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const PURPOSE_KEYS: Record<(typeof CONSENT_PURPOSES_UI)[number], { label: DictKey; desc: DictKey }> = {
  public_card: { label: 'privacy.purpose.public_card', desc: 'privacy.purpose.public_card.desc' },
  event_directory: { label: 'privacy.purpose.event_directory', desc: 'privacy.purpose.event_directory.desc' },
  introduction_fields: { label: 'privacy.purpose.introduction_fields', desc: 'privacy.purpose.introduction_fields.desc' },
  service_channel: { label: 'privacy.purpose.service_channel', desc: 'privacy.purpose.service_channel.desc' },
  organizer_marketing: { label: 'privacy.purpose.organizer_marketing', desc: 'privacy.purpose.organizer_marketing.desc' },
  product_marketing: { label: 'privacy.purpose.product_marketing', desc: 'privacy.purpose.product_marketing.desc' },
};

export default async function PrivacyPage() {
  const accountId = await requireAccountId('/me/privacy');
  const { t } = await getT();
  const sql = getSql();

  const [consentRows, blockRows, profileRows] = await Promise.all([
    sql<{ purpose: string; action: string }[]>`
      SELECT DISTINCT ON (purpose) purpose, action
      FROM consent_events
      WHERE account_id = ${accountId} AND scope_type = 'global'
      ORDER BY purpose, created_at DESC`,
    sql<{ target_account_id: string; created_at: Date; display_name: string | null }[]>`
      SELECT b.target_account_id, b.created_at, p.display_name
      FROM blocks b
      LEFT JOIN profiles p ON p.account_id = b.target_account_id
      WHERE b.blocker_account_id = ${accountId}
      ORDER BY b.created_at DESC`,
    sql<{ display_name: string }[]>`SELECT display_name FROM profiles WHERE account_id = ${accountId} LIMIT 1`,
  ]);

  const latest = new Map(consentRows.map((r) => [r.purpose, r.action]));
  const purposeRows: ConsentToggleRow[] = CONSENT_PURPOSES_UI.map((purpose) => ({
    purpose,
    granted: latest.get(purpose) === 'grant',
    label: t(PURPOSE_KEYS[purpose].label),
    description: t(PURPOSE_KEYS[purpose].desc),
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{t('privacy.title')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('privacy.subtitle')}</p>
      <div className="mt-6">
        <PrivacyPanel
          purposeRows={purposeRows}
          blocks={blockRows.map((b) => ({
            target_account_id: b.target_account_id,
            created_at: new Date(b.created_at).toISOString(),
            label: b.display_name ?? t('privacy.blockedOn', { date: new Date(b.created_at).toLocaleDateString() }),
          }))}
          displayName={profileRows[0]?.display_name ?? null}
          policyVersion={POLICY_VERSION}
          strings={{
            consentsTitle: t('privacy.consentsTitle'),
            consentsHint: t('privacy.consentsHint'),
            granted: t('privacy.grant'),
            notGranted: t('privacy.withdraw'),
            actionGrant: t('privacy.actionGrant'),
            actionWithdraw: t('privacy.actionWithdraw'),
            blocksTitle: t('privacy.blocksTitle'),
            blocksEmpty: t('privacy.blocksEmpty'),
            unblock: t('privacy.unblock'),
            exportTitle: t('privacy.exportTitle'),
            exportText: t('privacy.exportText'),
            exportDisclosure: t('privacy.exportDisclaimer'),
            exportButton: t('privacy.exportButton'),
            exporting: t('privacy.exporting'),
            deleteTitle: t('privacy.deleteTitle'),
            deleteText: t('privacy.deleteText'),
            deleteButton: t('privacy.deleteButton'),
            deleteModalTitle: t('privacy.deleteModalTitle'),
            deleteStep1: t('privacy.deleteStep1'),
            deleteStep2Template: t('privacy.deleteStep2'),
            deleteConfirmPlaceholder: t('privacy.deleteConfirmPlaceholder'),
            deleteConfirmButton: t('privacy.deleteConfirmButton'),
            deleteNameMismatch: t('privacy.deleteNameMismatch'),
            deleteFailed: t('privacy.deleteFailed'),
            cancel: t('common.cancel'),
            errorNetwork: t('common.errorNetwork'),
          }}
        />
      </div>
    </div>
  );
}

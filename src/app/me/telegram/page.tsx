import type { Metadata } from 'next';
import { getSql } from '../../../lib/db';
import { requireAccountId } from '../../../lib/session-page';
import { getT } from '../../../i18n';
import { TelegramBinding } from './telegram-binding';

export const metadata: Metadata = { title: 'Telegram', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

export default async function TelegramPage() {
  const accountId = await requireAccountId('/me/telegram');
  const { t } = await getT();
  const sql = getSql();
  const rows = await sql<{ external_id: string; state: string }[]>`
    SELECT external_id, state FROM channel_bindings
    WHERE account_id = ${accountId} AND provider = 'telegram' AND state = 'active' LIMIT 1`;
  const bound = rows[0] ?? null;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{t('telegram.title')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('telegram.subtitle')}</p>

      <div className="card mt-6">
        <h2 className="eyebrow">{t('telegram.statusTitle')}</h2>
        <p className="mt-2 text-sm" data-testid="tg-status">
          {bound ? t('telegram.bound', { handle: bound.external_id }) : t('telegram.notBound')}
        </p>
        <div className="mt-4">
          <TelegramBinding
            strings={{
              linkButton: t('telegram.linkButton'),
              linking: t('telegram.linking'),
              step1: t('telegram.step1'),
              deepLink: t('telegram.deepLink'),
              step2: t('telegram.step2'),
              confirmButton: t('telegram.confirmButton'),
              confirming: t('telegram.confirming'),
              confirmed: t('telegram.confirmed'),
              expiryNote: t('telegram.expiryNote'),
              unlink: t('telegram.unlink'),
              unlinking: t('telegram.unlinking'),
              unlinkConfirmText: t('telegram.unlinkConfirmText'),
              cancel: t('common.cancel'),
              linkFailed: t('telegram.linkFailed'),
              errorNetwork: t('common.errorNetwork'),
            }}
          />
        </div>
      </div>
    </div>
  );
}

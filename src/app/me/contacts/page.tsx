import type { Metadata } from 'next';
import { requireAccountId } from '../../../lib/session-page';
import { getT } from '../../../i18n';
import { ContactsManager, type ContactKind } from './contacts-manager';

export const metadata: Metadata = { title: 'Контакты', robots: { index: false, follow: false } };

export default async function ContactsPage() {
  await requireAccountId('/me/contacts');
  const { t } = await getT();

  const labels: Record<ContactKind, string> = {
    whatsapp: t('contacts.kind.whatsapp'),
    telegram_username: t('contacts.kind.telegram_username'),
    linkedin_url: t('contacts.kind.linkedin_url'),
    website: t('contacts.kind.website'),
    phone: t('contacts.kind.phone'),
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-extrabold tracking-tight">{t('contacts.title')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('contacts.subtitle')}</p>
      <div className="mt-6">
        <ContactsManager
          labels={labels}
          strings={{
            valueLabel: t('contacts.valueLabel'),
            valueRequired: t('contacts.valueRequired'),
            publicEnabled: t('contacts.publicEnabled'),
            publicWarning: t('contacts.publicWarning'),
            save: t('contacts.save'),
            saving: t('common.saving'),
            savedToast: t('contacts.savedToast'),
            empty: t('contacts.empty'),
            loading: t('common.loading'),
            hintEncrypted: t('contacts.hintEncrypted'),
            publishedBadge: t('contacts.publishedBadge'),
            privateBadge: t('contacts.privateBadge'),
            errorNetwork: t('common.errorNetwork'),
            errorGeneric: t('common.errorGeneric'),
          }}
        />
      </div>
    </div>
  );
}

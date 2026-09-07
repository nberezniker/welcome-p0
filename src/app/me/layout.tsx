import type { Metadata } from 'next';
import Link from 'next/link';
import { getT } from '../../i18n';
import { requireAccountId } from '../../lib/session-page';
import { Brand } from '../../components/site-chrome';
import { LocaleSwitcher } from '../../components/locale-switcher';
import { MeNav, SignOutButton } from './me-nav';

export const metadata: Metadata = {
  title: 'Мой WELCOME',
  robots: { index: false, follow: false },
};

/** Authenticated shell: server-side session gate (no client trust). */
export default async function MeLayout({ children }: { children: React.ReactNode }) {
  await requireAccountId();
  const { locale, t } = await getT();

  const items = [
    { href: '/me', label: t('me.nav.dashboard') },
    { href: '/me/profile', label: t('me.nav.profile') },
    { href: '/me/contacts', label: t('me.nav.contacts') },
    { href: '/me/introductions', label: t('me.nav.introductions') },
    { href: '/me/notes', label: t('me.nav.notes') },
    { href: '/me/events', label: t('me.nav.events') },
    { href: '/me/telegram', label: t('me.nav.telegram') },
    { href: '/me/privacy', label: t('me.nav.privacy') },
    { href: '/organizer', label: t('me.nav.organizer') },
  ];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line bg-white/60">
        <div className="mx-auto w-full max-w-6xl px-5 py-3 sm:px-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link href="/me" aria-label="WELCOME — my dashboard">
              <Brand compact />
            </Link>
            <div className="flex items-center gap-2">
              <LocaleSwitcher current={locale} ariaLabel={t('locale.switch')} />
              <SignOutButton label={t('common.signOut')} />
            </div>
          </div>
          <div className="mt-3 overflow-x-auto pb-1">
            <MeNav items={items} ariaLabel={t('me.navPrimary')} />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:px-7">
        {children}
      </main>
      <footer className="border-t border-line px-5 py-4 text-xs text-muted sm:px-7">
        <div className="mx-auto w-full max-w-6xl">{t('common.demoNotice')}</div>
      </footer>
    </div>
  );
}

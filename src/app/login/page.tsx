import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getT } from '../../i18n';
import { safeNextPath } from '../../lib/redirect';
import { getOptionalAccountId } from '../../lib/session-page';
import { SiteHeader, SiteFooter } from '../../components/site-chrome';
import { LoginFlow } from './login-flow';

export const metadata: Metadata = {
  title: 'Вход',
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { locale, t } = await getT();
  const accountId = await getOptionalAccountId();
  if (accountId) redirect('/me');
  const params = await searchParams;
  const rawNext = typeof params.next === 'string' ? params.next : null;
  // F-10: shared validator also rejects backslash protocol-relative bypasses.
  const nextPath = safeNextPath(rawNext);

  return (
    <>
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <SiteHeader
        locale={locale}
        links={[]}
        authLabel={t('common.backToHome')}
        authHref="/"
        switcherLabel={t('locale.switch')}
      />
      <main id="main" className="mx-auto w-full max-w-xl px-5 py-14 sm:px-6">
        <div className="card">
          <h1 className="text-2xl font-extrabold tracking-tight">{t('login.title')}</h1>
          <p className="mt-1.5 text-sm text-muted">{t('login.subtitle')}</p>
          <div className="mt-6">
            <LoginFlow
              nextPath={nextPath}
              strings={{
                emailLabel: t('login.emailLabel'),
                emailError: t('login.emailError'),
                sendCode: t('login.sendCode'),
                sending: t('login.sending'),
                codeStepTitle: t('login.codeStepTitle'),
                codeSentToTemplate: t('login.codeSentTo'),
                codeLabel: t('login.codeLabel'),
                codeError: t('login.codeError'),
                codeInvalid: t('login.codeInvalid'),
                verify: t('login.verify'),
                verifying: t('login.verifying'),
                changeEmail: t('login.changeEmail'),
                devHintTitle: t('login.devHintTitle'),
                devHintCodeTemplate: t('login.devHintCode'),
                devHintNote: t('login.devHintNote'),
                tryAgain: t('login.tryAgain'),
                errorNetwork: t('common.errorNetwork'),
                errorRateLimited: t('common.errorRateLimited'),
              }}
            />
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-muted">
          <Link href="/" className="underline underline-offset-2 hover:text-ink">
            {t('common.backToHome')}
          </Link>
        </p>
      </main>
      <SiteFooter
        statusLine={t('landing.footerStatus')}
        privacyLabel={t('landing.footerPrivacy')}
        privacyHref="/me/privacy"
        localeLinks={[]}
      />
    </>
  );
}

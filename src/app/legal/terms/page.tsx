import type { Metadata } from 'next';
import Link from 'next/link';
import { getT } from '../../../i18n';
import { SiteHeader, SiteFooter } from '../../../components/site-chrome';
import { LegalSection, legalFooterStrings } from '../content';

export const metadata: Metadata = {
  title: 'Terms of Use',
  description: 'The rules for using WELCOME: acceptable use, disclaimers and limitation of liability.',
};

export default async function LegalTermsPage() {
  const { locale, t } = await getT();
  const footer = legalFooterStrings(t);

  return (
    <>
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <SiteHeader
        locale={locale}
        links={[]}
        authLabel={t('common.signIn')}
        authHref="/login"
        switcherLabel={t('locale.switch')}
      />
      <main id="main" className="mx-auto w-full max-w-3xl px-5 py-12 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Legal · EN</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">Terms of Use</h1>
        <p className="mt-2 text-sm text-muted">
          Version 2026-09-p0 · This document is provided in English; localized versions are planned.
        </p>

        <div className="mt-6 rounded-xl border border-line bg-[#f7f6f1] p-4 text-sm">
          <strong>Development notice.</strong> WELCOME is an early-stage (P0) project. These terms
          govern the current test build and must be reviewed by a lawyer before any commercial launch.
        </div>

        <LegalSection title="1. Using the service">
          <p>
            WELCOME lets you maintain a personal networking profile, share it through a QR code and
            manage introductions at events. By creating an account you accept these terms. You provide
            accurate information, keep one account per person and are responsible for the content you
            publish on your card. Demo accounts are synthetic and exist for testing only.
          </p>
        </LegalSection>

        <LegalSection title="2. Acceptable use">
          <ul className="list-disc space-y-1 pl-5">
            <li>Do not use the service for unlawful purposes, spam or harassment.</li>
            <li>
              Do not harvest, scrape or redistribute other attendees’ data. Contact details of other
              people are shown to you only after mutual consent and must stay between you.
            </li>
            <li>Do not attempt to access accounts, events or data that are not yours.</li>
            <li>Event organizers are responsible for having a lawful basis for the guest lists they import.</li>
          </ul>
        </LegalSection>

        <LegalSection title="3. Availability and your data">
          <p>
            The service is under active development; features and this document may change. You can
            export your data at any time from the app, and delete your account from the Privacy
            section — deletion is described in the{' '}
            <Link href="/legal/privacy" className="underline underline-offset-2 hover:text-ink">Privacy Policy</Link>.
          </p>
        </LegalSection>

        <LegalSection title="4. Disclaimers">
          <p>
            THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE”, WITHOUT WARRANTIES OF ANY KIND, EXPRESS
            OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
            NON-INFRINGEMENT. We do not warrant that the service will be uninterrupted or error-free,
            or that other users will behave lawfully or respectfully.
          </p>
        </LegalSection>

        <LegalSection title="5. Limitation of liability">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, WELCOME AND ITS OPERATORS SHALL NOT BE LIABLE FOR
            INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF DATA,
            PROFITS OR GOODWILL ARISING FROM YOUR USE OF THE SERVICE. Nothing in these terms limits
            liability that cannot be limited by law (including liability towards consumers).
          </p>
        </LegalSection>

        <LegalSection title="6. Third-party services">
          <p>
            The service runs on infrastructure provided by Vercel Inc. and Neon, and — if you link a
            channel — delivers messages through Telegram. Use of those services is subject to the
            respective provider terms.
          </p>
        </LegalSection>

        <LegalSection title="7. Security issues">
          <p>
            Found a vulnerability? Please report it privately as described in the repository’s
            SECURITY.md (email: nberezniker@gmail.com, subject “welcome-p0 security”) instead of opening
            a public issue.
          </p>
        </LegalSection>

        <LegalSection title="8. Changes; contact">
          <p>
            These terms are versioned and may be updated as the product evolves; the current version
            applies to your use of the build. Questions: <strong>nberezniker@gmail.com</strong>.
          </p>
        </LegalSection>
      </main>
      <SiteFooter
        statusLine={footer.statusLine}
        privacyLabel={footer.privacyLabel}
        privacyHref="/legal/privacy"
        termsLabel={footer.termsLabel}
        termsHref="/legal/terms"
        localeLinks={[]}
      />
    </>
  );
}

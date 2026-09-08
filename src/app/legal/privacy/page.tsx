import type { Metadata } from 'next';
import Link from 'next/link';
import { getT } from '../../../i18n';
import { SiteHeader, SiteFooter } from '../../../components/site-chrome';
import { LegalSection, legalFooterStrings } from '../content';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How WELCOME processes personal data: purposes, legal bases, retention and your rights.',
};

export default async function LegalPrivacyPage() {
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
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted">
          Version 2026-09-p0 · This document is provided in English; localized versions are planned.
        </p>

        <div className="mt-6 rounded-xl border border-line bg-[#f7f6f1] p-4 text-sm">
          <strong>Development notice.</strong> WELCOME is an early-stage (P0) project in active
          development. This policy describes how the current build actually handles data, but the text
          has <em>not yet been reviewed by a lawyer</em> and must be re-reviewed before any commercial
          launch.
        </div>

        <LegalSection title="1. Who we are and how to contact us">
          <p>
            WELCOME is a personal-networking profile service: one persistent profile with a reusable QR,
            event context and contacts under your control. For questions about privacy or data
            protection, contact <strong>nberezniker@gmail.com</strong> (subject: “WELCOME privacy”).
          </p>
        </LegalSection>

        <LegalSection title="2. What data we process">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Profile data</strong> you enter: display name, headline, company, short bio,
              languages, offer/need tags, and a random public slug that forms your public card URL.
            </li>
            <li>
              <strong>Contact fields</strong> (e.g. whatsapp, phone, telegram username, website, LinkedIn
              URL). They are encrypted at rest (AES-256-GCM, per-value IV). Your login email is never
              stored in plaintext — only a keyed hash used for lookup.
            </li>
            <li>
              <strong>Event data</strong>: memberships, directory visibility and matching preferences,
              attendance markers.
            </li>
            <li>
              <strong>Introductions</strong>: mutual introduction state between two attendees and each
              side’s decision on which (if any) fields to reveal. Contact values are released to the
              other side only after BOTH parties accept.
            </li>
            <li>
              <strong>Consent records</strong>: every grant and withdrawal, with purpose, scope, policy
              version and timestamp.
            </li>
            <li>
              <strong>Organizer imports</strong>: guest lists uploaded by event organizers (name, email
              and provided columns), stored encrypted/quarantined until a guest claims their record.
            </li>
            <li>
              <strong>Security records</strong>: audit trail of security-relevant actions; the actor is
              pseudonymized after account deletion.
            </li>
          </ul>
        </LegalSection>

        <LegalSection title="3. Why we process it (purposes and legal bases)">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <strong>Providing the profile and public card</strong> — performance of a contract (the
              terms you accept by using the service).
            </li>
            <li>
              <strong>Event participation: joining, directory, recommendations</strong> — performance of
              a contract; you control directory visibility and matching per event.
            </li>
            <li>
              <strong>Introductions and revealing contact fields to another attendee</strong> — consent,
              given separately for each purpose and revocable at any time.
            </li>
            <li>
              <strong>Service messages through a linked Telegram channel</strong> — consent; the channel
              binding is created only through a two-sided confirmation flow, and /stop suppresses all
              queued sends immediately.
            </li>
            <li>
              <strong>Organizer marketing messages</strong> — consent, always scoped to a specific
              organizer event.
            </li>
            <li>
              <strong>Security, abuse prevention and audit</strong> — legitimate interest in keeping the
              service and its users safe (rate limiting, hashed credentials, audit trail).
            </li>
          </ul>
        </LegalSection>

        <LegalSection title="4. Cookies">
          <p>
            The service sets exactly two first-party cookies and uses no third-party scripts or
            trackers: <code>welcome_session</code> (strictly necessary, HttpOnly, keeps you signed in)
            and <code>welcome_locale</code> (your interface language preference).
          </p>
        </LegalSection>

        <LegalSection title="5. How long we keep data (retention)">
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Sessions</strong>: 30-day sliding TTL; expired sessions are deleted automatically.</li>
            <li><strong>Login codes (OTP)</strong>: stored only as hashes; deleted after 1 day.</li>
            <li><strong>Link challenges (channel binding / invites)</strong>: deleted 30 days after expiry.</li>
            <li><strong>Message queue records (inbox/outbox)</strong>: deleted 90 days after creation; the message text is stripped from delivered jobs earlier.</li>
            <li><strong>Imported guest registrations that were never claimed</strong>: deleted 30 days after the event ends.</li>
            <li>
              <strong>Account deletion</strong>: deletion signs you out immediately and disables your
              public card at once; user data (profile, contacts, sessions, channel bindings) is
              physically purged after a 7-day grace window. Registrations uploaded by organizers remain
              the organizer’s data; consent records are kept (with a pseudonymized reference) as a legal
              record of what was permitted.
            </li>
          </ul>
        </LegalSection>

        <LegalSection title="6. Your rights">
          <p>
            You can exercise the following directly in the app, without writing to us:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Access / portability</strong> — “Export my data” produces a machine-readable JSON file with your profile, decrypted contacts, consents, memberships, introductions (with your own consent record), notes, blocks and reports.</li>
            <li><strong>Rectification</strong> — edit your profile and contacts at any time.</li>
            <li><strong>Erasure</strong> — “Delete account” in the Privacy section (typed confirmation required).</li>
            <li><strong>Withdrawal of consent</strong> — purpose toggles in the Privacy section; withdrawing stops and suppresses future sends. In Telegram, /stop revokes the channel and clears the queue.</li>
          </ul>
          <p>
            You may also contact us at <strong>nberezniker@gmail.com</strong> to exercise rights, lodge a
            complaint or ask questions. If you are in the EU/EEA, you can complain to your local data
            protection authority.
          </p>
        </LegalSection>

        <LegalSection title="7. Processors and international transfers">
          <ul className="list-disc space-y-1 pl-5">
            <li><strong>Vercel Inc.</strong> — application hosting and edge network (deployment region: EU, Frankfurt).</li>
            <li><strong>Neon</strong> — managed PostgreSQL database (region: EU, Frankfurt).</li>
            <li><strong>Telegram</strong> — messaging channel, engaged only if YOU link your Telegram account; used to deliver notifications you consented to.</li>
          </ul>
          <p>
            Subprocessors are kept to this minimum; the list may change with the product, and this
            section will be updated accordingly. Data is stored in the EU; support access may involve
            transfers protected by standard contractual clauses.
          </p>
        </LegalSection>

        <LegalSection title="8. Security">
          <p>
            Contacts are encrypted at rest; login codes and session tokens are stored only as hashes;
            sensitive comparisons are constant-time; every mutating endpoint is guarded (same-origin
            checks, rate limits, object-level authorization). Vulnerabilities can be reported
            privately — see the repository’s SECURITY.md.
          </p>
        </LegalSection>

        <LegalSection title="9. Changes to this policy">
          <p>
            The policy is versioned; material changes will be announced in the app before they take
            effect. The current version applies to the P0 build described above.
          </p>
        </LegalSection>

        <p className="mt-10 text-sm">
          See also: <Link href="/legal/terms" className="underline underline-offset-2 hover:text-ink">Terms of Use</Link>.
        </p>
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

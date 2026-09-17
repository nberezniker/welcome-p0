import type { ReactNode } from 'react';
import type { DictKey } from '../../i18n';
import { operatorContactEmail } from '../../lib/env';
import { PROJECT_REPO_URL } from '../../lib/project';

/**
 * Shared building blocks for the legal pages (F-15). The body copy lives in
 * the EN pages; RU/ES locales currently fall back to the same English text
 * (documented decision — translations are planned before commercial launch),
 * so the legal body is intentionally NOT part of the i18n dictionaries.
 * Header/footer chrome strings stay localized.
 */
export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-extrabold tracking-tight">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-ink">{children}</div>
    </section>
  );
}

/**
 * Who a data subject writes to. The address is DEPLOYMENT configuration
 * (`OPERATOR_CONTACT_EMAIL`), never a literal in this source tree: the repo is
 * public and self-hosted, and a clone must not publish the upstream author's
 * personal inbox as the operator of somebody else's service.
 *
 * With no address configured the pages name the operator without inventing a
 * mailbox — a data-protection contact that silently drops mail would be worse
 * than an honest "not configured yet". SELF_HOSTING.md documents the variable.
 */
export function OperatorContact({ subject }: { subject?: string } = {}) {
  const email = operatorContactEmail();
  if (email.length === 0) {
    return (
      <>
        the operator of this deployment (this build has no contact address configured; the operator
        sets <code>OPERATOR_CONTACT_EMAIL</code>, and the project source is at{' '}
        <a href={PROJECT_REPO_URL} className="underline underline-offset-2" rel="noopener noreferrer">
          {PROJECT_REPO_URL}
        </a>
        )
      </>
    );
  }
  return (
    <>
      <strong>{email}</strong>
      {subject ? <> (subject: “{subject}”)</> : null}
    </>
  );
}

/** Footer strings resolved through i18n. */
export function legalFooterStrings(t: (key: DictKey) => string): {
  statusLine: string;
  privacyLabel: string;
  termsLabel: string;
} {
  return {
    statusLine: t('landing.footerStatus'),
    privacyLabel: t('landing.footerPrivacy'),
    termsLabel: t('landing.footerTerms'),
  };
}

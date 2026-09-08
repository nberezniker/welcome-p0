import type { ReactNode } from 'react';
import type { DictKey } from '../../i18n';

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

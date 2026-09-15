import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSql } from '../../lib/db';
import { requireAccountId } from '../../lib/session-page';
import { getT } from '../../i18n';
import { taxonomyPayload } from '../../domain/taxonomy';
import { parseCatalog } from '../../domain/picker';
import { SiteFooter, SiteHeader } from '../../components/site-chrome';
import { OnboardingFlow } from './onboarding-flow';

export const metadata: Metadata = { title: 'Onboarding', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * Onboarding "3 questions + confirmation" (ONBOARDING_MINI_LANDING.md).
 *
 * Reachable by any signed-in account that has no profile yet; an account that
 * already has one is sent to /me (the wizard is a one-time path, and /me sends
 * profile-less accounts back here — see src/app/me/page.tsx).
 *
 * The taxonomy catalogue is read straight from the domain module, so the wizard
 * renders with zero client round-trips; the pickers on other pages use the
 * cached GET /api/taxonomy instead.
 */
export default async function OnboardingPage() {
  const accountId = await requireAccountId('/onboarding');
  const { locale, t } = await getT();
  const sql = getSql();

  const rows = await sql<{ id: string }[]>`
    SELECT id FROM profiles WHERE account_id = ${accountId} LIMIT 1
  `;
  if (rows[0]) redirect('/me');

  const catalog = parseCatalog(taxonomyPayload());
  if (!catalog) {
    // The catalogue is a local module — an unusable payload is a build error, not
    // a user-facing state. Fail loudly instead of rendering an empty wizard.
    throw new Error('taxonomy catalogue payload is unusable');
  }

  const pickerStrings = {
    searchPlaceholder: t('pick.searchPlaceholder'),
    selected: t('pick.selected'),
    limitReached: t('pick.limitReached'),
    noResults: t('pick.noResults'),
    clear: t('pick.clear'),
    remove: t('pick.remove'),
    keywordPlaceholder: t('pick.keywordPlaceholder'),
    keywordTooLong: t('pick.keywordTooLong'),
    unspecified: t('pick.unspecified'),
  };

  return (
    <>
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <SiteHeader
        locale={locale}
        links={[]}
        authLabel={t('common.myProfile')}
        authHref="/me"
        switcherLabel={t('locale.switch')}
      />
      <main id="main" className="mx-auto w-full max-w-4xl px-5 py-10 sm:px-6">
        <OnboardingFlow
          catalog={catalog}
          locale={locale}
          strings={{
            title: t('onboarding.title'),
            subtitle: t('onboarding.subtitle'),
            progress: t('onboarding.progress'),
            step1Title: t('onboarding.step1Title'),
            step2Title: t('onboarding.step2Title'),
            step3Title: t('onboarding.step3Title'),
            step4Title: t('onboarding.step4Title'),
            nameLabel: t('onboarding.nameLabel'),
            nameError: t('onboarding.nameError'),
            headlineLabel: t('onboarding.headlineLabel'),
            companyLabel: t('onboarding.companyLabel'),
            bioLabel: t('onboarding.bioLabel'),
            languagesLabel: t('onboarding.languagesLabel'),
            languagesHint: t('onboarding.languagesHint'),
            back: t('onboarding.back'),
            next: t('onboarding.next'),
            nextNeedsName: t('onboarding.nextNeedsName'),
            draftRestored: t('onboarding.draftRestored'),
            draftReset: t('onboarding.draftReset'),
            linksTitle: t('onboarding.linksTitle'),
            linksHint: t('onboarding.linksHint'),
            linkInvalid: t('onboarding.linkInvalid'),
            publishTitle: t('onboarding.publishTitle'),
            publishHint: t('onboarding.publishHint'),
            publishCta: t('onboarding.publishCta'),
            publishing: t('onboarding.publishing'),
            saveError: t('onboarding.saveError'),
            contactSaveError: t('onboarding.contactSaveError'),
            enrich: {
              cta: t('enrich.cta'),
              busy: t('enrich.busy'),
              hint: t('enrich.hint'),
              sources: t('enrich.sources'),
              suggested: t('enrich.suggested'),
              apply: t('enrich.apply'),
              applied: t('enrich.applied'),
              noDraft: t('enrich.noDraft'),
              rateLimited: t('enrich.rateLimited'),
              disabled: t('enrich.disabled'),
              failed: t('enrich.failed'),
              retry: t('enrich.retry'),
              privacyNote: t('enrich.privacyNote'),
              errorNetwork: t('common.errorNetwork'),
            },
            goals: {
              title: t('goals.title'),
              hint: t('goals.hint'),
              limit: t('goals.limit'),
              counter: t('goals.counter'),
              clear: t('goals.clear'),
            },
            picker: pickerStrings,
            pick: {
              needTitle: t('pick.needTitle'),
              needHint: t('pick.needHint'),
              offerTitle: t('pick.offerTitle'),
              offerHint: t('pick.offerHint'),
              interestsTitle: t('pick.interestsTitle'),
              interestsHint: t('pick.interestsHint'),
              keywordsTitle: t('pick.keywordsTitle'),
              keywordsHint: t('pick.keywordsHint'),
              functionTitle: t('pick.functionTitle'),
              functionHint: t('pick.functionHint'),
              industryTitle: t('pick.industryTitle'),
              industryHint: t('pick.industryHint'),
            },
            fieldLabels: {
              headline: t('profile.headline'),
              company: t('profile.company'),
              short_bio: t('profile.shortBio'),
              languages: t('profile.languages'),
              need_intents: t('pick.needTitle'),
              offer_intents: t('pick.offerTitle'),
              interests: t('pick.interestsTitle'),
              keywords: t('pick.keywordsTitle'),
            },
            kindLabels: {
              linkedin_url: t('contacts.kind.linkedin_url'),
              website: t('contacts.kind.website'),
              github_url: t('contacts.kind.github_url'),
              telegram_username: t('contacts.kind.telegram_username'),
              whatsapp: t('contacts.kind.whatsapp'),
            },
            errorNetwork: t('common.errorNetwork'),
            errorGeneric: t('common.errorGeneric'),
          }}
        />
      </main>
      <SiteFooter
        statusLine={t('landing.footerStatus')}
        privacyLabel={t('landing.footerPrivacy')}
        privacyHref="/legal/privacy"
        termsLabel={t('landing.footerTerms')}
        termsHref="/legal/terms"
        localeLinks={[]}
      />
    </>
  );
}

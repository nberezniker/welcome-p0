import type { Metadata } from 'next';
import Link from 'next/link';
import { getT } from '../i18n';
import { appBaseUrl, pilotMailto } from '../lib/env';
import { PROJECT_REPO_URL } from '../lib/project';
import { landingShareMetadata } from '../lib/share-meta';
import { getOptionalAccountId } from '../lib/session-page';
import { SiteHeader, SiteFooter } from '../components/site-chrome';
import { FooterLocaleLinks } from '../components/footer-locale-links';

/**
 * Share metadata for the marketing page. The copy is read per request so the
 * unfurl speaks the locale this render resolved (`?lang=` → cookie → English),
 * the same resolution the page above uses; the title and description are the
 * very strings the preview image renders (src/app/opengraph-image.tsx), so a
 * pasted link and the picture beside it cannot promise different things.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return landingShareMetadata(
    { title: t('landing.metaTitle'), description: t('landing.metaDescription') },
    appBaseUrl(),
  );
}

/** Decorative deterministic QR-style mark (fictional, interface example only). */
function DemoQr({ label }: { label: string }) {
  const cells: { x: number; y: number }[] = [];
  const N = 21;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const finder =
        (x < 7 && y < 7) || (x >= N - 7 && y < 7) || (x < 7 && y >= N - 7);
      if (finder) continue;
      const on = ((x * 31 + y * 17 + ((x * y) % 7)) % 5) % 2 === 0;
      if (on) cells.push({ x, y });
    }
  }
  const finderAt = (fx: number, fy: number) => (
    <g key={`${fx}-${fy}`}>
      <rect x={fx} y={fy} width={7} height={7} fill="none" stroke="currentColor" strokeWidth={1} />
      <rect x={fx + 2} y={fy + 2} width={3} height={3} fill="currentColor" />
    </g>
  );
  return (
    <svg viewBox={`-1 -1 ${N + 2} ${N + 2}`} role="img" aria-label={label} className="h-full w-full text-ink">
      {cells.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width={1} height={1} fill="currentColor" />
      ))}
      {finderAt(0, 0)}
      {finderAt(N - 7, 0)}
      {finderAt(0, N - 7)}
    </svg>
  );
}

export default async function LandingPage() {
  const { locale, t } = await getT();
  const accountId = await getOptionalAccountId();
  const authed = accountId !== null;

  // Pilot contact: the operator's own inbox, never a hardcoded one. Unset means
  // this deployment publishes no address, so the pilot CTAs below are not
  // rendered at all (see src/lib/env.ts pilotMailto and SELF_HOSTING.md).
  const pilotMailtoHref = pilotMailto();

  // One entry per bullet, so the markup stays a plain list of items.
  const problemItems = [
    { title: t('landing.problem.item1Title'), text: t('landing.problem.item1Text') },
    { title: t('landing.problem.item2Title'), text: t('landing.problem.item2Text') },
    { title: t('landing.problem.item3Title'), text: t('landing.problem.item3Text') },
  ];
  const howSteps = [
    { num: t('landing.step1Kicker'), title: t('landing.step1Title'), text: t('landing.step1Text') },
    { num: t('landing.step2Kicker'), title: t('landing.step2Title'), text: t('landing.step2Text') },
    { num: t('landing.step3Kicker'), title: t('landing.step3Title'), text: t('landing.step3Text') },
  ];
  // The illustration walks the same three states a real request goes through.
  const consentFlow = [
    { icon: '↗', label: t('landing.howExample.step1Label'), text: t('landing.howExample.step1Text'), state: t('landing.howExample.closedLabel'), open: false },
    { icon: '✓', label: t('landing.howExample.step2Label'), text: t('landing.howExample.step2Text'), state: t('landing.howExample.closedLabel'), open: false },
    { icon: '→', label: t('landing.howExample.step3Label'), text: t('landing.howExample.step3Text'), state: t('landing.howExample.openLabel'), open: true },
  ];
  const memberItems = [
    { title: t('landing.forMember.item1Title'), text: t('landing.forMember.item1Text') },
    { title: t('landing.forMember.item2Title'), text: t('landing.forMember.item2Text') },
    { title: t('landing.forMember.item3Title'), text: t('landing.forMember.item3Text') },
    { title: t('landing.forMember.item4Title'), text: t('landing.forMember.item4Text') },
  ];
  const organizerItems = [
    { title: t('landing.forOrganizer.item1Title'), text: t('landing.forOrganizer.item1Text') },
    { title: t('landing.forOrganizer.item2Title'), text: t('landing.forOrganizer.item2Text') },
    { title: t('landing.forOrganizer.item3Title'), text: t('landing.forOrganizer.item3Text') },
    { title: t('landing.forOrganizer.item4Title'), text: t('landing.forOrganizer.item4Text') },
  ];
  const trustItems = [
    { title: t('landing.trust.item1Title'), text: t('landing.trust.item1Text') },
    { title: t('landing.trust.item2Title'), text: t('landing.trust.item2Text') },
    { title: t('landing.trust.item3Title'), text: t('landing.trust.item3Text') },
    { title: t('landing.trust.item4Title'), text: t('landing.trust.item4Text') },
  ];
  const faqItems = [
    { q: t('landing.faq.q1'), a: t('landing.faq.a1') },
    { q: t('landing.faq.q2'), a: t('landing.faq.a2') },
    { q: t('landing.faq.q3'), a: t('landing.faq.a3') },
    { q: t('landing.faq.q4'), a: t('landing.faq.a4') },
    { q: t('landing.faq.q5'), a: t('landing.faq.a5') },
    // The pilot question carries the mailto CTA — a person, not a form.
    { q: t('landing.faq.q6'), a: t('landing.faq.a6'), link: true },
  ];

  return (
    <>
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <SiteHeader
        locale={locale}
        links={[
          { href: '#how', label: t('landing.navHow') },
          { href: '#member', label: t('landing.navMember') },
          { href: '#organizer', label: t('landing.navOrganizer') },
          { href: '#faq', label: t('landing.navFaq') },
        ]}
        authLabel={authed ? t('common.myProfile') : t('common.signIn')}
        authHref={authed ? '/me' : '/login'}
        switcherLabel={t('locale.switch')}
      />

      <main id="main">
        <div className="mx-auto w-full max-w-6xl px-5 sm:px-7">
          {/* Demo status banner — honest P0 framing (spec guardrail). */}
          <p className="mt-4 rounded-xl border border-line bg-mint px-4 py-2.5 text-xs font-semibold text-pine" role="status">
            {t('landing.demoBanner')}
          </p>

          {/* Hero */}
          <section
            aria-labelledby="hero-title"
            data-testid="hero"
            className="grid items-center gap-10 py-12 md:grid-cols-[1.07fr_1fr] md:py-16"
          >
            <div>
              <p className="eyebrow">
                <span className="eyebrow-dot" /> {t('landing.eyebrow')}
              </p>
              <h1
                id="hero-title"
                className="mt-5 max-w-[21ch] text-4xl font-extrabold leading-[1.06] tracking-tight sm:text-5xl lg:text-6xl"
              >
                {t('landing.titleLine1')}
                <br />
                {t('landing.titleLine2')}
                <br />
                <em className="not-italic text-accent">{t('landing.titleEmphasis')}</em>
              </h1>
              <p className="mt-6 max-w-md text-base leading-relaxed text-muted">{t('landing.subtitle')}</p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link href="/login" className="btn-accent" data-testid="cta-demo">
                  {t('landing.heroCtaDemo')} <span aria-hidden="true">↗</span>
                </Link>
                <Link href="/organizer" className="btn-outline" data-testid="cta-organizer">
                  {t('landing.heroCtaOrganizer')} <span aria-hidden="true">→</span>
                </Link>
              </div>
              <p className="mt-4 text-[11px] leading-relaxed text-muted">
                {t('landing.micro1')}
                <br />
                {t('landing.micro2')}
              </p>
            </div>

            {/* Fictional phone card */}
            <div className="relative hidden justify-center md:flex" aria-label={t('landing.fictionalNote')}>
              <div className="absolute inset-x-8 bottom-0 top-10 rounded-[48px] bg-[#e4eadf]" aria-hidden="true" />
              <div className="relative w-[300px] rotate-2 rounded-[36px] border-8 border-ink bg-white p-5 shadow-xl">
                <div className="mb-5 flex justify-between text-[10px] font-bold">
                  <span>WELCOME / {t('me.nav.profile').toUpperCase()}</span>
                  <span>DEMO</span>
                </div>
                <div
                  aria-hidden="true"
                  className="grid size-16 place-items-center rounded-2xl bg-mint text-2xl font-bold text-pine"
                >
                  {t('landing.cardName')
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((w) => w[0])
                    .join('')}
                </div>
                <p className="mt-3 text-xl font-bold leading-tight tracking-tight">{t('landing.cardName')}</p>
                <p className="text-xs leading-relaxed text-muted">
                  {t('landing.cardRole')}
                  <br />
                  {t('landing.cardBio')}
                </p>
                <hr className="my-4 border-line" />
                <p className="text-[11px] leading-relaxed">
                  {t('landing.cardLooking')}
                  <br />
                  <span className="mt-1 inline-block rounded-md bg-mint px-2 py-1 text-[10px] font-semibold text-pine">
                    {t('landing.cardTag')}
                  </span>
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <div className="size-24 shrink-0 rounded-lg border border-line bg-white p-1.5">
                    <DemoQr label={t('landing.cardQrTitle')} />
                  </div>
                  <div>
                    <strong className="block text-[11px] leading-snug">{t('landing.cardQrTitle')}</strong>
                    <span className="mt-1 block text-[9px] text-muted">{t('landing.cardQrNote')}</span>
                  </div>
                </div>
              </div>
              <p className="absolute bottom-1 right-6 text-[10px] text-muted">{t('landing.fictionalNote')}</p>
            </div>
          </section>

          {/* Principles strip — the hero argument in one line */}
          <div className="grid gap-4 border-y border-line py-5 sm:grid-cols-3">
            {[
              ['↗', t('landing.principle1')],
              ['↔', t('landing.principle2')],
              ['✓', t('landing.principle3')],
            ].map(([icon, label]) => (
              <p key={label} className="flex items-center gap-3 text-sm font-semibold">
                <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-white text-base">
                  {icon}
                </span>
                {label}
              </p>
            ))}
          </div>

          {/* The problem */}
          <section id="problem" data-testid="section-problem" className="py-16" aria-labelledby="problem-title">
            <div className="mb-8 max-w-2xl">
              <p className="eyebrow">
                <span className="eyebrow-dot" /> {t('landing.problem.eyebrow')}
              </p>
              <h2 id="problem-title" className="mt-3 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                {t('landing.problem.title')}
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted">{t('landing.problem.subtitle')}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {problemItems.map((item) => (
                <article key={item.title} className="card">
                  <h3 className="text-lg font-bold leading-snug tracking-tight">{item.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{item.text}</p>
                </article>
              ))}
            </div>
          </section>

          {/* How it works */}
          <section id="how" data-testid="section-how" className="pb-16" aria-labelledby="how-title">
            <div className="mb-8 max-w-2xl">
              <p className="eyebrow">
                <span className="eyebrow-dot" /> {t('landing.howEyebrow')}
              </p>
              <h2 id="how-title" className="mt-3 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                {t('landing.howTitle')}
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted">{t('landing.howSubtitle')}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {howSteps.map((step) => (
                <article key={step.num} className="card">
                  <p className="text-[11px] font-bold tracking-[0.15em] text-accent">{step.num}</p>
                  <h3 className="mt-4 text-lg font-bold leading-snug tracking-tight">{step.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{step.text}</p>
                </article>
              ))}
            </div>

            {/* Consent flow illustration — text and glyphs only, no external assets. */}
            <div className="card mt-6" data-testid="how-example">
              <h3 className="text-lg font-bold leading-snug tracking-tight">{t('landing.howExample.title')}</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">{t('landing.howExample.note')}</p>
              <ol className="mt-5 border-t border-line">
                {consentFlow.map((row) => (
                  <li
                    key={row.label}
                    className="flex items-start gap-4 border-b border-line py-4 last:border-b-0"
                  >
                    <span
                      aria-hidden="true"
                      className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-paper text-base"
                    >
                      {row.icon}
                    </span>
                    {/* Label and state share a line; the text keeps the full column. */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-sm font-bold">{row.label}</span>
                        <span
                          className={
                            row.open
                              ? 'rounded-full bg-mint px-3 py-1 text-[11px] font-semibold text-pine'
                              : 'rounded-full border border-line bg-white px-3 py-1 text-[11px] font-semibold text-muted'
                          }
                        >
                          {row.state}
                        </span>
                      </div>
                      <p className="mt-1 text-[13px] leading-relaxed text-muted">{row.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          {/* For members */}
          <section
            id="member"
            data-testid="section-member"
            className="grid items-center gap-8 pb-16 md:grid-cols-2"
            aria-labelledby="member-title"
          >
            {/* Decorative card mock; the section heading lives in the next column. */}
            <div className="rounded-3xl bg-ink p-8 text-white sm:p-10">
              <p className="text-2xl font-extrabold leading-snug tracking-tight">{t('landing.cardQrTitle')}</p>
              <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-[#bbc8be]">
                {t('landing.micro1')} {t('landing.micro2')}
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                {['LinkedIn', 'WhatsApp', 'Telegram', t('contacts.kind.phone')].map((s) => (
                  <span key={s} className="rounded-lg border border-white/25 bg-white/5 px-2.5 py-1.5 text-[11px]">
                    {s}
                  </span>
                ))}
              </div>
              <Link href="/login" className="btn-light mt-7" data-testid="member-cta">
                {t('landing.ctaOpen')} <span aria-hidden="true">↗</span>
              </Link>
            </div>
            <div>
              <p className="eyebrow">
                <span className="eyebrow-dot" /> {t('landing.forMember.eyebrow')}
              </p>
              <h2 id="member-title" className="mt-3 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                {t('landing.forMember.title')}
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted">{t('landing.forMember.subtitle')}</p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                {memberItems.map((item) => (
                  <article key={item.title} className="card-tight">
                    <h3 className="text-sm font-bold leading-snug tracking-tight">{item.title}</h3>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{item.text}</p>
                  </article>
                ))}
              </div>
            </div>
          </section>

          {/* For organizers */}
          <section id="organizer" data-testid="section-organizer" className="pb-16" aria-labelledby="organizer-title">
            <div className="mb-8 max-w-2xl">
              <p className="eyebrow">
                <span className="eyebrow-dot" /> {t('landing.forOrganizer.eyebrow')}
              </p>
              <h2 id="organizer-title" className="mt-3 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                {t('landing.forOrganizer.title')}
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted">{t('landing.forOrganizer.subtitle')}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {organizerItems.map((item) => (
                <article key={item.title} className="card">
                  <h3 className="text-lg font-bold leading-snug tracking-tight">{item.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{item.text}</p>
                </article>
              ))}
            </div>
            {/* Consent guardrail: the organizer sells no reach the member did not grant. */}
            <div className="mt-4 rounded-2xl border border-line bg-mint p-6" data-testid="organizer-consent-note">
              <h3 className="text-lg font-bold leading-snug tracking-tight text-pine">
                {t('landing.forOrganizer.consentNoteTitle')}
              </h3>
              <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-pine">
                {t('landing.forOrganizer.consentNote')}
              </p>
            </div>
          </section>

          {/* Trust and privacy */}
          <section id="trust" data-testid="section-trust" className="pb-16" aria-labelledby="trust-title">
            <div className="mb-8 max-w-2xl">
              <p className="eyebrow">
                <span className="eyebrow-dot" /> {t('landing.trust.eyebrow')}
              </p>
              <h2 id="trust-title" className="mt-3 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                {t('landing.trust.title')}
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted">{t('landing.trust.subtitle')}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {trustItems.map((item) => (
                <article key={item.title} className="card">
                  <h3 className="flex items-start gap-2 text-lg font-bold leading-snug tracking-tight">
                    <span aria-hidden="true" className="font-bold text-pine">
                      ✓
                    </span>
                    {item.title}
                  </h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{item.text}</p>
                </article>
              ))}
            </div>
            <div className="mt-4 rounded-2xl border border-line bg-accent-pale p-6" data-testid="trust-no-scraping">
              <h3 className="text-lg font-bold leading-snug tracking-tight">{t('landing.trust.noScrapingTitle')}</h3>
              <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-muted">{t('landing.trust.noScraping')}</p>
            </div>
          </section>

          {/* FAQ */}
          <section id="faq" data-testid="section-faq" className="pb-16" aria-labelledby="faq-title">
            <div className="mb-8 max-w-2xl">
              <p className="eyebrow">
                <span className="eyebrow-dot" /> {t('landing.faq.eyebrow')}
              </p>
              <h2 id="faq-title" className="mt-3 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                {t('landing.faq.title')}
              </h2>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {faqItems.map((item) => (
                <details key={item.q} className="group rounded-2xl border border-line bg-white p-5" data-testid="faq-item">
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-4 [&::-webkit-details-marker]:hidden">
                    <h3 className="text-base font-bold leading-snug tracking-tight">{item.q}</h3>
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-lg font-bold leading-none text-accent transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="mt-3 text-[13px] leading-relaxed text-muted">{item.a}</p>
                  {item.link && pilotMailtoHref ? (
                    <a
                      href={pilotMailtoHref}
                      className="mt-3 inline-flex text-[13px] font-semibold text-ink underline underline-offset-2 hover:text-accent"
                      data-testid="faq-pilot-link"
                    >
                      {t('landing.faq.a6Link')} <span aria-hidden="true">↗</span>
                    </a>
                  ) : null}
                </details>
              ))}
            </div>
          </section>

          {/* Closing CTA */}
          <section
            id="start"
            data-testid="section-final-cta"
            className="mb-12 rounded-3xl bg-ink px-6 py-14 text-center text-white sm:px-8"
            aria-labelledby="final-cta-title"
          >
            <h2 id="final-cta-title" className="mx-auto max-w-xl text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
              {t('landing.finalCta.title')}
            </h2>
            <p className="mt-4 text-sm text-[#becabd]">{t('landing.finalCta.text')}</p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Link href="/login" className="btn-accent" data-testid="final-cta-demo">
                {t('landing.finalCta.ctaDemo')} <span aria-hidden="true">↗</span>
              </Link>
              {pilotMailtoHref ? (
                <a
                  href={pilotMailtoHref}
                  className="btn-outline !border-[#8a9a8a] !text-white hover:!bg-white/10"
                  data-testid="final-cta-pilot"
                >
                  {t('landing.finalCta.ctaPilot')} <span aria-hidden="true">→</span>
                </a>
              ) : null}
            </div>
            {pilotMailtoHref ? (
              <p className="mt-4 text-[11px] text-[#a9b6ab]">{t('landing.finalCta.pilotNote')}</p>
            ) : null}
          </section>
        </div>
      </main>

      <SiteFooter
        statusLine={t('landing.footerStatus')}
        privacyLabel={t('landing.footerPrivacy')}
        privacyHref="/legal/privacy"
        termsLabel={t('landing.footerTerms')}
        termsHref="/legal/terms"
        repoLabel={t('landing.footerRepo')}
        repoHref={PROJECT_REPO_URL}
        localeLinks={[]}
      />
      <div className="mx-auto w-full max-w-6xl px-5 pb-6 sm:px-7">
        <FooterLocaleLinks
          current={locale}
          label={t('locale.switch')}
          links={[
            { locale: 'en', label: 'English' },
            { locale: 'ru', label: 'Русский' },
            { locale: 'es', label: 'Español' },
          ]}
        />
      </div>
    </>
  );
}

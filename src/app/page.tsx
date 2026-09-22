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

/**
 * The marketing landing.
 *
 * IT IS BUILT FOR A PHONE, AND IT IS MEASURED THERE. At 390px this page was
 * 7853px tall — 9.3 screens of scrolling, against 1.2 for the event page and 1.8
 * for the card. The cause was not the amount of copy, it was how the copy was
 * packaged: 27 separate cards, each paying 48px of padding and a 16px grid gap
 * for one sentence, plus the same promise made twice in the first screen. The
 * four things that were changed, in the order they mattered:
 *
 *   1. THE PROMISE IS MADE ONCE. The hero carried both a paragraph and, directly
 *      below it, three bullets saying the same three things. The paragraph is
 *      gone (its dictionary key went with it) and the three bullets stayed,
 *      moved up into the hero: a scannable list, one claim per line, including
 *      "contacts open only by mutual consent" — which is the product's core claim
 *      and is stated most strongly in that form. Nothing else in the first
 *      screen repeated it.
 *   2. ONE PANEL PER SECTION, ONE ROW PER CLAIM (`.panel` / `.claim`, defined in
 *      globals.css). Same 18 claims, same words, ~64px of chrome each instead of
 *      ~64px of chrome plus a card's own padding.
 *   3. THE HONESTY NOTICE IS A LINE, NOT A BLOCK. `landing.demoBanner` is
 *      unchanged, verbatim, and still a `role="status"` region — it just stopped
 *      being a filled box with its own vertical rhythm above the fold.
 *   4. THE FAQ KEEPS ITS ANSWERS AND LOSES ITS HEIGHT. It was already native
 *      `<details>`/`<summary>`, so nothing had to be collapsed for the first
 *      time; what changed is that the 22px-tall summary — the smallest tap target
 *      on the page — now takes the full 44px row, which costs less than the
 *      padding the closed row used to carry anyway.
 *
 * WHAT WAS NOT DONE, because the page's job is to explain the product: no
 * section was removed, no claim was dropped, no traction, logo or benchmark was
 * invented, and the two standing honesty guardrails (the organizer consent note
 * and the no-scraping note) are still on the page in full — they are what the
 * spec's §7 rules require and the e2e gate asserts them by text.
 *
 * The height is asserted, not assumed: tests/e2e/landing.spec.ts measures
 * `documentElement.scrollHeight` at 390px in all three locales and fails if it
 * creeps back over its bound.
 */
export default async function LandingPage() {
  const { locale, t } = await getT();
  const accountId = await getOptionalAccountId();
  const authed = accountId !== null;

  // Pilot contact: the operator's own inbox, never a hardcoded one. Unset means
  // this deployment publishes no address, so the pilot CTAs below are not
  // rendered at all (see src/lib/env.ts pilotMailto and SELF_HOSTING.md).
  const pilotMailtoHref = pilotMailto();

  /**
   * The hero's three claims — the ONE statement of the promise on the first
   * screen (see the note above). Kept as a list of items so the markup stays a
   * plain list, and the glyphs stay decorative: each row also says its claim in
   * words.
   */
  const heroClaims = [
    { icon: '↗', label: t('landing.principle1') },
    { icon: '↔', label: t('landing.principle2') },
    { icon: '✓', label: t('landing.principle3') },
  ];
  // One entry per row, so each list below is a plain list of claims.
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

  /**
   * One claim list, rendered the same way in every section that has one: a
   * single panel, a hairline between rows, and a heading per claim so the
   * document outline keeps the levels the e2e gate checks (h2 section → h3
   * claim, never a skipped level).
   */
  const claimList = (testId: string, items: { title: string; text: string }[]) => (
    <ul className="panel panel-rows" data-testid={testId}>
      {items.map((item) => (
        <li key={item.title} className="claim">
          <h3 className="claim-title">{item.title}</h3>
          <p className="claim-text">{item.text}</p>
        </li>
      ))}
    </ul>
  );

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
          {/*
            Demo status banner — honest P0 framing (spec guardrail). One line,
            under the header where a status line belongs, instead of a filled
            block above the fold: the text is unchanged and still announced
            (`role="status"`), only its box is gone.
          */}
          <p
            className="mt-2 flex items-start gap-2 border-b border-line pb-2 text-xs font-semibold text-pine"
            data-testid="status-notice"
            role="status"
          >
            <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-accent" />
            {t('landing.demoBanner')}
          </p>

          {/* Hero — H1 plus the ONE statement of the promise. */}
          <section
            aria-labelledby="hero-title"
            data-testid="hero"
            className="grid items-start gap-6 py-5 md:grid-cols-[1.07fr_1fr] md:py-10"
          >
            <div>
              <p className="eyebrow">
                <span className="eyebrow-dot" /> {t('landing.eyebrow')}
              </p>
              <h1
                id="hero-title"
                className="mt-4 max-w-[21ch] text-4xl font-extrabold leading-[1.06] tracking-tight sm:text-5xl lg:text-6xl"
              >
                {t('landing.titleLine1')}
                <br />
                {t('landing.titleLine2')}
                <br />
                <em className="not-italic text-accent">{t('landing.titleEmphasis')}</em>
              </h1>
              <ul className="mt-6 grid gap-2" data-testid="hero-claims">
                {heroClaims.map((claim) => (
                  <li key={claim.label} className="flex items-start gap-2.5 text-sm font-semibold">
                    <span
                      aria-hidden="true"
                      className="mt-px grid size-4 shrink-0 place-items-center rounded border border-line bg-white text-[10px]"
                    >
                      {claim.icon}
                    </span>
                    {claim.label}
                  </li>
                ))}
              </ul>
              {/* One CTA row, one width rule, one arrow glyph (→) — see `.cta-row`. */}
              <div className="cta-row mt-6">
                <Link href="/login" className="btn-accent btn-cta" data-testid="cta-demo">
                  {t('landing.heroCtaDemo')} <span aria-hidden="true">→</span>
                </Link>
                <Link href="/organizer" className="btn-outline btn-cta" data-testid="cta-organizer">
                  {t('landing.heroCtaOrganizer')} <span aria-hidden="true">→</span>
                </Link>
              </div>
              <p className="mt-2.5 text-xs leading-snug text-muted" data-testid="hero-micro">
                {t('landing.micro1')} · {t('landing.micro2')}
              </p>
            </div>

            {/* Fictional phone card. Its own note stays attached to it. */}
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

          {/* The problem */}
          <section id="problem" data-testid="section-problem" className="pb-5" aria-labelledby="problem-title">
            <div className="mb-2 max-w-2xl">
              <h2 id="problem-title" className="text-xl font-extrabold leading-tight tracking-tight sm:text-3xl">
                <span className="eyebrow mr-2 align-middle">
                  <span className="eyebrow-dot" /> {t('landing.problem.eyebrow')}
                </span>
                {t('landing.problem.title')}
              </h2>
              <p className="mt-1 text-xs leading-snug text-muted">{t('landing.problem.subtitle')}</p>
            </div>
            {claimList('problem-list', problemItems)}
          </section>

          {/* How it works */}
          <section id="how" data-testid="section-how" className="pb-5" aria-labelledby="how-title">
            <div className="mb-2 max-w-2xl">
              <h2 id="how-title" className="text-xl font-extrabold leading-tight tracking-tight sm:text-3xl">
                <span className="eyebrow mr-2 align-middle">
                  <span className="eyebrow-dot" /> {t('landing.howEyebrow')}
                </span>
                {t('landing.howTitle')}
              </h2>
              <p className="mt-1 text-xs leading-snug text-muted">{t('landing.howSubtitle')}</p>
            </div>
            <ul className="panel panel-rows" data-testid="how-steps">
              {howSteps.map((step) => (
                <li key={step.num} className="claim">
                  <p className="text-[11px] font-bold tracking-[0.15em] text-accent">{step.num}</p>
                  <h3 className="mt-0.5 claim-title">{step.title}</h3>
                  <p className="claim-text">{step.text}</p>
                </li>
              ))}
            </ul>

            {/* Consent flow illustration — text and glyphs only, no external assets. */}
            <div className="panel mt-4" data-testid="how-example">
              <div className="px-5 py-3">
                <h3 className="claim-title">{t('landing.howExample.title')}</h3>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{t('landing.howExample.note')}</p>
              </div>
              <ol className="panel-rows border-t border-line">
                {consentFlow.map((row) => (
                  <li key={row.label} className="flex items-start gap-3 px-5 py-2.5">
                    <span
                      aria-hidden="true"
                      className="grid size-6 shrink-0 place-items-center rounded-md border border-line bg-paper text-[11px]"
                    >
                      {row.icon}
                    </span>
                    {/* Label and state share a line; the text keeps the full column. */}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs font-bold sm:text-sm">{row.label}</span>
                        <span
                          className={
                            row.open
                              ? 'rounded-full bg-mint px-2 py-0.5 text-[10px] font-semibold text-pine'
                              : 'rounded-full border border-line bg-white px-2 py-0.5 text-[10px] font-semibold text-muted'
                          }
                        >
                          {row.state}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted">{row.text}</p>
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
            className="grid items-start gap-6 pb-5 md:grid-cols-2"
            aria-labelledby="member-title"
          >
            {/*
              The dark mock, and the only one a phone sees (the hero's phone card
              is `hidden md:flex`). Its note is `landing.fictionalNote` rather than
              the micro pair it used to repeat: those two lines are already stated
              in the hero, directly under the CTA they belong to, and this way the
              "what you are looking at is an example" note — previously desktop
              only — is on the page at every width.
            */}
            <div className="hidden rounded-2xl bg-ink p-5 text-white md:block" data-testid="member-mock">
              <p className="text-lg font-extrabold leading-snug tracking-tight">{t('landing.cardQrTitle')}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-[#bbc8be]">{t('landing.fictionalNote')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {['LinkedIn', 'WhatsApp', 'Telegram', t('contacts.kind.phone')].map((s) => (
                  <span key={s} className="rounded-lg border border-white/25 bg-white/5 px-2.5 py-1 text-[11px]">
                    {s}
                  </span>
                ))}
              </div>
              <Link href="/login" className="btn-light btn-cta mt-4" data-testid="member-cta">
                {t('landing.ctaOpen')} <span aria-hidden="true">→</span>
              </Link>
            </div>
            <div>
              <h2 id="member-title" className="text-xl font-extrabold leading-tight tracking-tight sm:text-3xl">
                <span className="eyebrow mr-2 align-middle">
                  <span className="eyebrow-dot" /> {t('landing.forMember.eyebrow')}
                </span>
                {t('landing.forMember.title')}
              </h2>
              <p className="mt-1 text-xs leading-snug text-muted">{t('landing.forMember.subtitle')}</p>
              <div className="mt-3">{claimList('member-list', memberItems)}</div>
            </div>
          </section>

          {/* For organizers */}
          <section id="organizer" data-testid="section-organizer" className="pb-5" aria-labelledby="organizer-title">
            <div className="mb-2 max-w-2xl">
              <h2 id="organizer-title" className="text-xl font-extrabold leading-tight tracking-tight sm:text-3xl">
                <span className="eyebrow mr-2 align-middle">
                  <span className="eyebrow-dot" /> {t('landing.forOrganizer.eyebrow')}
                </span>
                {t('landing.forOrganizer.title')}
              </h2>
              <p className="mt-1 text-xs leading-snug text-muted">{t('landing.forOrganizer.subtitle')}</p>
            </div>
            {claimList('organizer-list', organizerItems)}
            {/* Consent guardrail: the organizer sells no reach the member did not grant. */}
            <div className="panel panel-tinted mt-3 px-5 py-3" data-testid="organizer-consent-note">
              <h3 className="claim-title text-pine">{t('landing.forOrganizer.consentNoteTitle')}</h3>
              <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-pine">
                {t('landing.forOrganizer.consentNote')}
              </p>
            </div>
          </section>

          {/* Trust and privacy */}
          <section id="trust" data-testid="section-trust" className="pb-5" aria-labelledby="trust-title">
            <div className="mb-2 max-w-2xl">
              <h2 id="trust-title" className="text-xl font-extrabold leading-tight tracking-tight sm:text-3xl">
                <span className="eyebrow mr-2 align-middle">
                  <span className="eyebrow-dot" /> {t('landing.trust.eyebrow')}
                </span>
                {t('landing.trust.title')}
              </h2>
              <p className="mt-1 text-xs leading-snug text-muted">{t('landing.trust.subtitle')}</p>
            </div>
            {claimList('trust-list', trustItems)}
            <div className="panel panel-pale mt-3 px-5 py-3" data-testid="trust-no-scraping">
              <h3 className="claim-title">{t('landing.trust.noScrapingTitle')}</h3>
              <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-muted">{t('landing.trust.noScraping')}</p>
            </div>
          </section>

          {/*
            FAQ. Native disclosures, closed on load — the answers are all still in
            the document, and the row is the tap target. `min-h-11` on the summary
            is what makes the target 44px: the padding moved from the closed box
            onto the summary, so the row a thumb hits is the row that was already
            there.
          */}
          <section id="faq" data-testid="section-faq" className="pb-5" aria-labelledby="faq-title">
            <div className="mb-2 max-w-2xl">
              <h2 id="faq-title" className="text-xl font-extrabold leading-tight tracking-tight sm:text-3xl">
                <span className="eyebrow mr-2 align-middle">
                  <span className="eyebrow-dot" /> {t('landing.faq.eyebrow')}
                </span>
                {t('landing.faq.title')}
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {faqItems.map((item) => (
                <details key={item.q} className="panel group" data-testid="faq-item">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-1 [&::-webkit-details-marker]:hidden">
                    <h3 className="text-xs font-bold leading-snug tracking-tight sm:text-sm">{item.q}</h3>
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-lg font-bold leading-none text-accent transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <div className="px-4 pb-3">
                    <p className="text-xs leading-relaxed text-muted">{item.a}</p>
                    {item.link && pilotMailtoHref ? (
                      <a
                        href={pilotMailtoHref}
                        className="mt-1.5 inline-flex text-xs font-semibold text-ink underline underline-offset-2 hover:text-accent"
                        data-testid="faq-pilot-link"
                      >
                        {t('landing.faq.a6Link')} <span aria-hidden="true">→</span>
                      </a>
                    ) : null}
                  </div>
                </details>
              ))}
            </div>
          </section>

          {/* Closing CTA */}
          <section
            id="start"
            data-testid="section-final-cta"
            className="mb-6 rounded-3xl bg-ink px-6 py-7 text-center text-white sm:px-8"
            aria-labelledby="final-cta-title"
          >
            <h2
              id="final-cta-title"
              className="mx-auto max-w-xl text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl"
            >
              {t('landing.finalCta.title')}
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-[#becabd] sm:text-sm">{t('landing.finalCta.text')}</p>
            <div className={`mt-5 ${pilotMailtoHref ? 'cta-row' : 'cta-row-lone'}`}>
              <Link href="/login" className="btn-accent btn-cta" data-testid="final-cta-demo">
                {t('landing.finalCta.ctaDemo')} <span aria-hidden="true">→</span>
              </Link>
              {pilotMailtoHref ? (
                <a
                  href={pilotMailtoHref}
                  className="btn-outline btn-cta !border-[#8a9a8a] !text-white hover:!bg-white/10"
                  data-testid="final-cta-pilot"
                >
                  {t('landing.finalCta.ctaPilot')} <span aria-hidden="true">→</span>
                </a>
              ) : null}
            </div>
            {pilotMailtoHref ? (
              <p className="mt-2.5 text-xs text-[#a9b6ab]">{t('landing.finalCta.pilotNote')}</p>
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
      />
      <div className="mx-auto w-full max-w-6xl px-5 pb-4 sm:px-7">
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

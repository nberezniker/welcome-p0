import Link from 'next/link';
import { getT } from '../i18n';
import { getOptionalAccountId } from '../lib/session-page';
import { SiteHeader, SiteFooter } from '../components/site-chrome';
import { FooterLocaleLinks } from '../components/footer-locale-links';

export const metadata = {
  robots: { index: true, follow: true },
};

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

  return (
    <>
      <a href="#main" className="skip-link">
        {t('common.skipToContent')}
      </a>
      <SiteHeader
        locale={locale}
        links={[
          { href: '#personal', label: t('landing.principle1') },
          { href: '#events', label: t('landing.organizerEyebrow') },
          { href: '#how', label: t('landing.howEyebrow') },
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
          <section aria-labelledby="hero-title" className="grid items-center gap-10 py-12 md:grid-cols-[1.07fr_1fr] md:py-16">
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
                <Link href="/login" className="btn-accent" data-testid="cta-personal">
                  {t('landing.ctaPersonal')} <span aria-hidden="true">↗</span>
                </Link>
                <a href="#events" className="btn-outline">
                  {t('landing.ctaEvent')} <span aria-hidden="true">→</span>
                </a>
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
                <h3 className="mt-3 text-xl font-bold leading-tight tracking-tight">{t('landing.cardName')}</h3>
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

          {/* Principles strip */}
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

          {/* How it works */}
          <section id="how" className="py-16" aria-labelledby="how-title">
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
              {[
                { num: t('landing.step1Kicker'), title: t('landing.step1Title'), text: t('landing.step1Text') },
                { num: t('landing.step2Kicker'), title: t('landing.step2Title'), text: t('landing.step2Text') },
                { num: t('landing.step3Kicker'), title: t('landing.step3Title'), text: t('landing.step3Text') },
              ].map((step) => (
                <article key={step.num} className="card">
                  <p className="text-[11px] font-bold tracking-[0.15em] text-accent">{step.num}</p>
                  <h3 className="mt-4 text-lg font-bold leading-snug tracking-tight">{step.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{step.text}</p>
                </article>
              ))}
            </div>
          </section>

          {/* Personal section */}
          <section id="personal" className="grid items-center gap-8 pb-16 md:grid-cols-2" aria-label={t('landing.principle1')}>
            <div className="rounded-3xl bg-ink p-8 text-white sm:p-10">
              <p className="eyebrow !text-[#bccbbe]">{t('landing.principle1')}</p>
              <h3 className="mt-4 text-2xl font-extrabold leading-snug tracking-tight">
                {t('landing.cardQrTitle')}
              </h3>
              <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-[#bbc8be]">{t('landing.micro1')} {t('landing.micro2')}</p>
              <div className="mt-6 flex flex-wrap gap-2">
                {['LinkedIn', 'WhatsApp', 'Telegram', t('contacts.kind.phone')].map((s) => (
                  <span key={s} className="rounded-lg border border-white/25 bg-white/5 px-2.5 py-1.5 text-[11px]">
                    {s}
                  </span>
                ))}
              </div>
              <Link href="/login" className="btn-light mt-7">
                {t('landing.ctaOpen')} <span aria-hidden="true">↗</span>
              </Link>
            </div>
            <div>
              <h2 className="text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                {t('landing.trustTitle')}
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted">{t('landing.trustText')}</p>
              <ul className="mt-4 divide-y divide-line border-t border-line">
                {[t('landing.trustItem1'), t('landing.trustItem2'), t('landing.trustItem3')].map((item) => (
                  <li key={item} className="flex gap-3 py-3 text-[13px]">
                    <span aria-hidden="true" className="font-bold text-pine">✓</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* Event organizer section */}
          <section id="events" className="pb-16" aria-labelledby="events-title">
            <div className="mb-8 max-w-2xl">
              <p className="eyebrow">
                <span className="eyebrow-dot" /> {t('landing.organizerEyebrow')}
              </p>
              <h2 id="events-title" className="mt-3 text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
                {t('landing.organizerTitle')}
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-muted">{t('landing.organizerSubtitle')}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              {[
                { num: t('landing.organizerStep1Kicker'), title: t('landing.organizerStep1Title'), text: t('landing.organizerStep1Text') },
                { num: t('landing.organizerStep2Kicker'), title: t('landing.organizerStep2Title'), text: t('landing.organizerStep2Text') },
                { num: t('landing.organizerStep3Kicker'), title: t('landing.organizerStep3Title'), text: t('landing.organizerStep3Text') },
              ].map((step) => (
                <article key={step.num} className="card">
                  <p className="text-[11px] font-bold tracking-[0.15em] text-accent">{step.num}</p>
                  <h3 className="mt-4 text-lg font-bold leading-snug tracking-tight">{step.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{step.text}</p>
                </article>
              ))}
            </div>
          </section>

          {/* Closing CTA */}
          <section className="mb-12 rounded-3xl bg-ink px-6 py-14 text-center text-white sm:px-8" aria-labelledby="closing-title">
            <h2 id="closing-title" className="mx-auto max-w-xl text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
              {t('landing.closingTitle')}
            </h2>
            <p className="mt-4 text-sm text-[#becabd]">{t('landing.closingText')}</p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Link href="/login" className="btn-accent">
                {t('landing.ctaPersonal')} <span aria-hidden="true">↗</span>
              </Link>
              <a href="#events" className="btn-outline !border-[#8a9a8a] !text-white hover:!bg-white/10">
                {t('landing.ctaEvent')} <span aria-hidden="true">→</span>
              </a>
            </div>
          </section>
        </div>
      </main>

      <SiteFooter
        statusLine={t('landing.footerStatus')}
        privacyLabel={t('landing.footerPrivacy')}
        privacyHref="/me/privacy"
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

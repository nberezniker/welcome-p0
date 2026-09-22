import Link from 'next/link';
import { LocaleSwitcher } from './locale-switcher';

export interface HeaderNavLink {
  href: string;
  label: string;
}

/** Rotated-W brand mark from the reference design. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid -rotate-6 place-items-center rounded-xl bg-ink font-extrabold text-white"
        style={{ width: compact ? 26 : 37, height: compact ? 26 : 37, fontSize: compact ? 17 : 24, borderRadius: compact ? 8 : 11 }}
      >
        W
      </span>
      <span className={compact ? 'text-lg font-extrabold tracking-tight' : 'text-2xl font-extrabold tracking-tight'}>
        WELCOME
      </span>
    </span>
  );
}

/**
 * Public site header with landmarks. Purely presentational (props come from
 * server parents so client bundles never ship dictionaries).
 *
 * TWO ROWS ON A PHONE, AND WHY THAT IS THE CHEAP OPTION. At 390px the brand, the
 * three language controls and the account link do not fit on one line inside the
 * 350px the padding leaves: one row needs about 340px of content and the brand
 * wordmark alone is 166 of it. The choice is between a control that wraps by
 * accident inside a fixed 80px box (which is what used to happen, and it is
 * visible as a cramped two-line header) and a header that is two rows ON PURPOSE.
 * The second one costs ~28px of height and buys every control the 44px target
 * the rest of the app holds to, so that is the one taken. From `sm` the header
 * goes back to a single 96px row, and the section links appear at `md`.
 *
 * THE CONTROLS DELIBERATELY DO NOT COMPETE WITH THE PRIMARY ACTION: the account
 * link is `btn-nav` (outline) rather than the solid `btn-primary` pill it used to
 * carry — which, next to the solid active-language pill, made two dark blocks
 * heavier than the accent CTA they sit above (see globals.css).
 */
export function SiteHeader({
  locale,
  links,
  authLabel,
  authHref,
  switcherLabel,
}: {
  locale: string;
  links: HeaderNavLink[];
  authLabel: string;
  authHref: string;
  switcherLabel: string;
}) {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-1.5 sm:h-24 sm:px-7 sm:py-0">
        {/* min-h-11: the wordmark is also a link, and it is the one control in
            the header that would otherwise be shorter than the 44px the rest of
            the header holds to. */}
        <Link href="/" aria-label="WELCOME — home" className="inline-flex min-h-11 shrink-0 items-center">
          <Brand />
        </Link>
        <nav aria-label="Main navigation" className="hidden gap-6 text-sm font-semibold md:flex">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="text-ink underline-offset-4 hover:underline">
              {l.label}
            </a>
          ))}
        </nav>
        {/* `w-full` at base is what makes the second row deliberate rather than
            accidental: the controls take a row of their own and spread across it. */}
        <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
          <LocaleSwitcher current={locale} ariaLabel={switcherLabel} />
          <Link href={authHref} className="btn-nav" data-testid="header-auth-link">
            {authLabel}
          </Link>
        </div>
      </div>
    </header>
  );
}

/**
 * Public site footer: privacy + terms links, an optional repository link, and an
 * honest status line.
 *
 * IT NO LONGER CARRIES A `localeLinks` PROP. Every call site passed `[]`, so the
 * labelled nav it guarded was dead code — and the one page that DOES offer
 * language links (the landing) renders `FooterLocaleLinks`, which switches
 * in place over `POST /api/locale` instead of doing a full navigation. Two
 * implementations of "the language links", one of them unreachable, is how the
 * two drift apart; the reachable one stayed.
 */
export function SiteFooter({
  statusLine,
  privacyLabel,
  privacyHref,
  termsLabel,
  termsHref,
  repoLabel,
  repoHref,
}: {
  statusLine: string;
  privacyLabel: string;
  privacyHref: string;
  termsLabel?: string;
  termsHref?: string;
  repoLabel?: string;
  repoHref?: string;
}) {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-4 text-xs text-muted sm:flex-row sm:items-start sm:justify-between sm:px-7">
        <div>
          <span className="text-base font-extrabold tracking-tight text-ink">WELCOME</span>
          <p className="mt-1">{statusLine}</p>
        </div>
        {/* A wrapping ROW on a phone, a column from `sm`: three short links
            stacked vertically cost the footer 76px on the device where the page
            is longest, and all three fit on one line at 390px. */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 sm:flex-col sm:gap-x-0">
          <Link href={privacyHref} className="underline underline-offset-2 hover:text-ink">
            {privacyLabel}
          </Link>
          {termsLabel && termsHref ? (
            <Link href={termsHref} className="underline underline-offset-2 hover:text-ink">
              {termsLabel}
            </Link>
          ) : null}
          {/* External links carry an explicit rel, as on the public card. */}
          {repoLabel && repoHref ? (
            <a
              href={repoHref}
              rel="noopener noreferrer"
              target="_blank"
              data-testid="footer-repo-link"
              className="underline underline-offset-2 hover:text-ink"
            >
              {repoLabel}
            </a>
          ) : null}
        </div>
      </div>
    </footer>
  );
}

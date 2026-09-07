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
      <div className="mx-auto flex h-20 w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 sm:h-24 sm:px-7">
        <Link href="/" aria-label="WELCOME — home" className="shrink-0">
          <Brand />
        </Link>
        <nav aria-label="Main navigation" className="hidden gap-6 text-sm font-semibold md:flex">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="text-ink underline-offset-4 hover:underline">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <LocaleSwitcher current={locale} ariaLabel={switcherLabel} />
          <Link href={authHref} className="btn-primary btn-small" data-testid="header-auth-link">
            {authLabel}
          </Link>
        </div>
      </div>
    </header>
  );
}

/** Public site footer: locale links, privacy page link, honest status line. */
export function SiteFooter({
  statusLine,
  privacyLabel,
  privacyHref,
  localeLinks,
}: {
  statusLine: string;
  privacyLabel: string;
  privacyHref: string;
  localeLinks: { locale: string; href: string; label: string }[];
}) {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-7 text-xs text-muted sm:flex-row sm:items-start sm:justify-between sm:px-7">
        <div>
          <span className="text-base font-extrabold tracking-tight text-ink">WELCOME</span>
          <p className="mt-1">{statusLine}</p>
        </div>
        <div className="flex flex-col gap-1">
          <Link href={privacyHref} className="underline underline-offset-2 hover:text-ink">
            {privacyLabel}
          </Link>
          <div className="mt-1 flex gap-2" aria-label="Locale links">
            {localeLinks.map((l) => (
              <a key={l.locale} href={l.href} lang={l.locale} className="underline underline-offset-2 hover:text-ink">
                {l.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}

import type { Metadata, Viewport } from 'next';
import { getT } from '../i18n';
import { appBaseUrl } from '../lib/env';
import { getTheme } from '../lib/theme-page';
import { HydrationMarker } from '../components/hydration-marker';
import { ThemeBar } from '../components/theme-bar';
import './globals.css';

/**
 * Canonical origin for the app's RELATIVE metadata URLs — in practice the
 * `og:image` that the file convention (app/p/[slug]/opengraph-image.tsx,
 * app/e/[slug]/opengraph-image.tsx) derives from a relative path.
 *
 * Without it Next falls back to the deployment host (VERCEL_URL in production),
 * which is not the domain people share and may sit behind deployment
 * protection — a link unfurler would then get an image it cannot fetch. A
 * malformed APP_BASE_URL returns null so pages keep rendering with Next's own
 * default rather than failing every request at module load.
 */
function canonicalMetadataBase(): URL | null {
  try {
    return new URL(appBaseUrl());
  } catch {
    return null;
  }
}

export const metadata: Metadata = {
  metadataBase: canonicalMetadataBase() ?? undefined,
  title: {
    default: 'WELCOME',
    template: '%s · WELCOME',
  },
  description:
    'Personal networking profile: one reusable QR, event context and contacts under your control.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The ONE place that decides `<html data-theme>` and the only place that may
  // render the review bar — a theme is a document-level fact (the token sets in
  // globals.css hang off `html[data-theme]`), and the bar has to be outside every
  // page's own containers so it can never sit on top of what is being reviewed.
  const [{ locale, t }, theme] = await Promise.all([getT(), getTheme()]);
  return (
    // No theme → NO attribute at all, so a page with no explicit theme is
    // byte-identical to the pre-theme one (the `soft` tokens live on `:root`).
    <html lang={locale} data-theme={theme ?? undefined}>
      <body className="min-h-screen antialiased">
        <HydrationMarker />
        {children}
        {theme ? (
          <ThemeBar
            current={theme}
            labels={{
              title: t('theme.bar'),
              group: t('theme.group'),
              option: t('theme.option'),
              hint: t('theme.barHint'),
              exit: t('theme.exit'),
              names: {
                soft: t('theme.soft'),
                swiss: t('theme.swiss'),
                poster: t('theme.poster'),
                premium: t('theme.premium'),
              },
            }}
          />
        ) : null}
      </body>
    </html>
  );
}

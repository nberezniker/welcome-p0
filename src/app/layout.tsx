import type { Metadata, Viewport } from 'next';
import { getT } from '../i18n';
import { appBaseUrl } from '../lib/env';
import { HydrationMarker } from '../components/hydration-marker';
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
  // The `--t-*` token layer in globals.css lives on `:root`, so the one design
  // that ships IS the default — there is no `data-theme` attribute anywhere and
  // no query, cookie or switcher that could select a second one. The mechanism
  // that would carry a second look (an `html[data-theme="…"]` token block, a
  // `Theme` type, the `?theme=` plumbing) is documented in
  // docs-internal/design/THEMES.md, so a future design direction can be added
  // back without rediscovering it.
  const { locale } = await getT();
  return (
    <html lang={locale}>
      <body className="min-h-screen antialiased">
        <HydrationMarker />
        {children}
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from 'next';
import { getLocale } from '../i18n';
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
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body className="min-h-screen antialiased">
        <HydrationMarker />
        {children}
      </body>
    </html>
  );
}

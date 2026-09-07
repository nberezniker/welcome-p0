import type { Metadata, Viewport } from 'next';
import { getLocale } from '../i18n';
import './globals.css';

export const metadata: Metadata = {
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
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}

import Link from 'next/link';
import { t, type Locale } from '../i18n';

/** 403 view for organizer pages the viewer's roles do not cover. */
export function ForbiddenPage({ locale }: { locale: Locale }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-20 text-center">
      <p className="text-6xl font-extrabold tracking-tight text-accent">403</p>
      <h1 className="mt-4 text-2xl font-extrabold tracking-tight">{t(locale, 'errors.403.title')}</h1>
      <p className="mt-2 text-sm text-muted">{t(locale, 'errors.403.text')}</p>
      <Link href="/organizer" className="btn-primary mt-6">
        {t(locale, 'errors.403.home')}
      </Link>
    </div>
  );
}

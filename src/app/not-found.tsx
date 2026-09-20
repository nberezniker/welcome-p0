import Link from 'next/link';
import { getT } from '../i18n';

/**
 * 404 for the whole app: an unmatched URL, or a `notFound()` raised by a page
 * whose object does not exist (an unknown card slug, an event the viewer cannot
 * see, someone else's resource).
 *
 * Deliberately chrome-free, like the 403 view (src/components/forbidden.tsx):
 * this file also renders INSIDE the /me shell when a cabinet page raises
 * notFound(), and a second site header inside the cabinet's own header would be
 * a bug rather than a design. The way out is in the copy: home, and a way to
 * sign in.
 *
 * Nothing about the failure is shown — not the requested path, not the reason,
 * not whether the object exists but is hidden. Refusing to distinguish those is
 * the same anti-enumeration rule the JSON API follows (tests/integration/
 * anti-enumeration.test.ts), and a 404 that says "that card exists but is
 * private" would undo it one HTML page at a time.
 */
export default async function NotFound() {
  const { t } = await getT();

  return (
    <main id="main" className="mx-auto w-full max-w-xl px-5 py-20 text-center sm:px-7">
      <p className="text-5xl font-extrabold tracking-tight text-accent">404</p>
      <h1 className="mt-4 text-3xl font-extrabold leading-tight tracking-tight">{t('errors.404.title')}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">{t('errors.404.text')}</p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <Link href="/" className="btn-primary">
          {t('common.backToHome')}
        </Link>
        <Link href="/login" className="btn-outline">
          {t('common.signIn')}
        </Link>
      </div>
    </main>
  );
}

/**
 * A `not-found.tsx` does not export `metadata` — Next renders the segment's own
 * metadata for the 404 response — and it does not need to: the response carries
 * `noindex`, because a 404 must never be indexed even when its URL was shared.
 */

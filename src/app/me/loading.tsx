import { getT } from '../../i18n';

/**
 * Loading surface for /me/* — the one part of the app where a person waits on
 * the database: the dashboard, the profile editor, the event directory and the
 * campaign pages all query before they can render anything.
 *
 * Placed at the /me segment root so it covers every cabinet route (and any
 * future one) without a file per page. Public pages get nothing: they are
 * statically rendered, so a spinner would only ever flash.
 *
 * Kept to a real heading and one line of copy. It is a Suspense fallback, so a
 * screen reader announces it through `role="status"` (implicit `aria-live`
 * "polite": the arrival of the real page is not urgent, and interrupting a
 * reader mid-sentence is worse than a moment of silence). No absolute overlay
 * and no fixed height: the fallback is replaced in place, so a skeleton tall
 * enough to jump the layout would move the content a person is already reading.
 */
export default async function MeLoading() {
  const { t } = await getT();

  return (
    <div role="status" className="mx-auto w-full max-w-xl px-1 py-16 text-center">
      <h1 className="text-2xl font-extrabold leading-tight tracking-tight">{t('me.loading.title')}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">{t('me.loading.text')}</p>
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSql } from '../../../../../lib/db';
import { requireAccountId } from '../../../../../lib/session-page';
import { getT } from '../../../../../i18n';
import { requireEventRole } from '../../../../../domain/organizer';
import { ForbiddenPage } from '../../../../../components/forbidden';
import { appBaseUrl } from '../../../../../lib/env';
import { loadBadgeSheet } from '../../../../../lib/badges';
import { BadgeSheet, type BadgeSheetStrings } from './badge-sheet';

export const metadata: Metadata = { title: 'QR-бейджи', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/** A4 sheet geometry: 2 columns × 4 rows (see .badge-sheet in globals.css). */
const BADGES_PER_SHEET = 8;

/**
 * Printable QR badge sheet for an event (owner/admin).
 *
 * Read-only by design: the page mints nothing. Claim links are one-time tokens
 * stored only as hashes, so they can only be handed out by the explicit POST
 * behind the "generate" button — never as a side effect of opening a page.
 *
 * The projection is deliberately minimal (name + QR target). Emails and phones
 * are not selected from the database at all, so they cannot reach the paper.
 */
export default async function BadgesPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const accountId = await requireAccountId(`/organizer/events/${eventId}/badges`);
  const { locale, t } = await getT();
  const sql = getSql();

  const role = await requireEventRole(sql, accountId, eventId, ['owner', 'admin']);
  if (!role) return <ForbiddenPage locale={locale} />;

  const data = await loadBadgeSheet(sql, role.eventId, appBaseUrl(), t('org.badgesNameFallback'));
  if (!data) notFound();
  const { event, cards, quarantined } = data;

  const strings: BadgeSheetStrings = {
    title: t('org.badgesTitle', { name: event.name }),
    subtitle: t('org.badgesSubtitle'),
    backLink: t('org.backToEvent'),
    print: t('org.badgesPrint'),
    linksTitle: t('org.badgesLinksTitle'),
    linksHint: t('org.badgesLinksHint'),
    generate: t('org.badgesGenerate'),
    generating: t('common.loading'),
    downloadCsv: t('org.badgesDownloadCsv'),
    csvFilename: `${event.slug}-claim-links.csv`,
    issuesLabel: t('org.badgesLinksIssued'),
    excluded: quarantined > 0 ? t('org.badgesExcludedQuarantined', { n: quarantined }) : null,
    empty: t('org.badgesEmpty'),
    errorGeneric: t('common.errorGeneric'),
    errorNetwork: t('common.errorNetwork'),
    qrAltTemplate: t('org.badgesQrAlt'),
  };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="no-print">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-extrabold tracking-tight">{strings.title}</h1>
          <Link href={`/organizer/events/${event.id}`} className="btn-light btn-small">
            {strings.backLink}
          </Link>
        </div>
        <p className="mt-1.5 text-sm text-muted">{strings.subtitle}</p>
      </div>

      <BadgeSheet eventId={event.id} cards={cards} strings={strings} perSheet={BADGES_PER_SHEET} />
    </div>
  );
}

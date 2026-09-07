import Link from 'next/link';
import type { Metadata } from 'next';
import { getSql } from '../../lib/db';
import { requireAccountId } from '../../lib/session-page';
import { appBaseUrl } from '../../lib/env';
import { getT } from '../../i18n';
import { CopyButton } from '../../components/copy-button';

export const metadata: Metadata = { title: 'Обзор', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

interface DashboardRow {
  profile: {
    id: string;
    public_slug: string;
    display_name: string;
    headline: string | null;
    company: string | null;
    short_bio: string | null;
    languages: string[];
    offer_tags: string[];
    need_tags: string[];
  } | null;
  publicContacts: number;
  telegramHandle: string | null;
}

async function loadDashboard(accountId: string): Promise<DashboardRow> {
  const sql = getSql();
  const [profileRows, contactRows, bindingRows] = await Promise.all([
    sql<{
      id: string;
      public_slug: string;
      display_name: string;
      headline: string | null;
      company: string | null;
      short_bio: string | null;
      languages: string[];
      offer_tags: string[];
      need_tags: string[];
    }[]>`SELECT id, public_slug, display_name, headline, company, short_bio, languages, offer_tags, need_tags
       FROM profiles WHERE account_id = ${accountId} LIMIT 1`,
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM contact_fields cf
      JOIN profiles p ON p.id = cf.profile_id
      WHERE p.account_id = ${accountId} AND cf.public_enabled = true`,
    sql<{ external_id: string | null }[]>`
      SELECT external_id FROM channel_bindings
      WHERE account_id = ${accountId} AND provider = 'telegram' AND state = 'active' LIMIT 1`,
  ]);
  return {
    profile: profileRows[0] ?? null,
    publicContacts: contactRows[0]?.count ?? 0,
    telegramHandle: bindingRows[0]?.external_id ?? null,
  };
}

export default async function DashboardPage() {
  const accountId = await requireAccountId('/me');
  const { t } = await getT();
  const { profile, publicContacts, telegramHandle } = await loadDashboard(accountId);

  if (!profile) {
    return (
      <div className="card mx-auto max-w-xl text-center">
        <h1 className="text-2xl font-extrabold tracking-tight">{t('me.dashboard.title')}</h1>
        <p className="mt-2 text-sm text-muted">{t('me.dashboard.createProfilePrompt')}</p>
        <Link href="/me/profile" className="btn-accent mt-6" data-testid="create-profile-cta">
          {t('me.dashboard.createProfileCta')}
        </Link>
      </div>
    );
  }

  const publicUrl = `${appBaseUrl()}/p/${profile.public_slug}`;
  const qrUrl = `/api/public/profiles/${encodeURIComponent(profile.public_slug)}/qr.svg`;

  const fields: { filled: boolean }[] = [
    { filled: profile.display_name.trim().length > 0 },
    { filled: (profile.headline ?? '').trim().length > 0 },
    { filled: (profile.company ?? '').trim().length > 0 },
    { filled: (profile.short_bio ?? '').trim().length > 0 },
    { filled: profile.languages.length > 0 },
    { filled: profile.offer_tags.length > 0 },
    { filled: profile.need_tags.length > 0 },
    { filled: publicContacts > 0 },
  ];
  const percent = Math.round((fields.filter((f) => f.filled).length / fields.length) * 100);

  const links = [
    { href: '/me/contacts', label: t('me.dashboard.quickContacts') },
    { href: '/me/introductions', label: t('me.dashboard.quickIntroductions') },
    { href: '/me/events', label: t('me.dashboard.quickEvents') },
    { href: '/me/privacy', label: t('me.dashboard.quickPrivacy') },
  ];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-extrabold tracking-tight" data-testid="dashboard-title">
        {t('me.dashboard.welcome', { name: profile.display_name })}
      </h1>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Public card + QR */}
        <section aria-labelledby="public-url-heading" className="card">
          <h2 id="public-url-heading" className="eyebrow">
            {t('me.dashboard.publicUrl')}
          </h2>
          <p className="mt-2 text-sm text-muted">{t('me.dashboard.publicUrlHint')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a
              href={publicUrl}
              className="min-w-0 flex-1 truncate rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs underline-offset-2 hover:underline"
              data-testid="public-url"
            >
              {publicUrl}
            </a>
            <CopyButton value={publicUrl} label={t('common.copy')} copiedLabel={t('common.copied')} testId="copy-public-url" />
          </div>

          <div className="mt-5 flex flex-col gap-5 sm:flex-row">
            <div className="shrink-0">
              <h3 className="eyebrow">{t('me.dashboard.qrTitle')}</h3>
              <p className="mt-2 max-w-xs text-xs text-muted">{t('me.dashboard.qrHint')}</p>
            </div>
            <div className="flex items-center gap-3">
              {/* QR image endpoint: /api/public/profiles/[slug]/qr.svg */}
              <img
                src={qrUrl}
                alt={t('me.dashboard.qrAlt', { name: profile.display_name })}
                width={128}
                height={128}
                className="size-32 rounded-lg border border-line bg-white p-1.5"
                data-testid="qr-image"
              />
              <div className="flex flex-col gap-2">
                <a className="btn-light btn-small" href={qrUrl} download={`welcome-${profile.public_slug}-qr.svg`}>
                  {t('me.dashboard.qrDownload')}
                </a>
                <a
                  className="btn-light btn-small"
                  href={`/api/public/profiles/${encodeURIComponent(profile.public_slug)}/vcard`}
                  data-testid="vcard-link"
                >
                  {t('me.dashboard.vcardDownload')}
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Completeness + quick links */}
        <div className="flex flex-col gap-6">
          <section aria-labelledby="completeness-heading" className="card">
            <h2 id="completeness-heading" className="eyebrow">
              {t('me.dashboard.completeness')}
            </h2>
            <div className="mt-3 flex items-center gap-3">
              <div
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('me.dashboard.completeness')}
                className="h-3 flex-1 overflow-hidden rounded-full bg-paper"
              >
                <div className="h-full rounded-full bg-pine" style={{ width: `${percent}%` }} />
              </div>
              <span className="text-sm font-bold tabular-nums" data-testid="completeness-pct">
                {percent}%
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">{t('me.dashboard.completenessHint', { percent })}</p>
            <Link href="/me/profile" className="btn-outline btn-small mt-4">
              {t('me.nav.profile')}
            </Link>
          </section>

          <section aria-labelledby="quick-heading" className="card">
            <h2 id="quick-heading" className="eyebrow">
              {t('me.dashboard.quickLinks')}
            </h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="btn-light btn-small">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              {publicContacts === 0 ? t('me.dashboard.noContactsYet') : ''}
              {telegramHandle
                ? t('me.dashboard.telegramBound')
                : publicContacts === 0
                  ? ''
                  : t('me.dashboard.telegramNotBound')}
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

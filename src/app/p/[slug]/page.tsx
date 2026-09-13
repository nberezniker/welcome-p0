import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  findSharedEvent,
  loadPublicProfile,
  type PublicContact,
} from '../../../lib/public-profile';
import { getT } from '../../../i18n';
import { getOptionalAccountId } from '../../../lib/session-page';
import { linkHref, type LinkKind } from '../../../domain/links';
import { labelsForIds, parseCatalog, type TaxonomyCatalog, type UiLocale } from '../../../domain/picker';
import { taxonomyPayload } from '../../../domain/taxonomy';
import { appBaseUrl } from '../../../lib/env';
import { ShareButton } from './share-button';
import { IntroCta, SignInCta } from './intro-cta';

export const dynamic = 'force-dynamic';

/** Shared-card meta: the only place a card is meant to be pasted into a chat. */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const { t } = await getT();
  const profile = await loadPublicProfile(slug);
  // A missing card must not leak "this slug exists" through metadata.
  if (!profile) return { title: t('pubcard.title'), robots: { index: false, follow: false } };

  const title = t('pubcard.metaTitle', { name: profile.display_name });
  const description = profile.headline
    ? t('pubcard.metaDescription', { headline: profile.headline })
    : (profile.short_bio ?? t('pubcard.title'));

  return {
    title,
    description,
    robots: { index: false, follow: false },
    openGraph: { title, description, type: 'profile' },
  };
}

/** Contact kinds that render as an outbound link, in display order. */
const CONTACT_ORDER: readonly PublicContact['kind'][] = [
  'linkedin_url',
  'github_url',
  'website',
  'telegram_username',
  'whatsapp',
  'phone',
];

/** The one place a stored contact becomes an href (see domain/links). */
function contactHref(contact: PublicContact): string | null {
  if (contact.kind === 'phone') {
    const digits = contact.value.replace(/[^\d+]/g, '');
    return digits.length > 0 ? `tel:${digits}` : null;
  }
  return linkHref(contact.kind as LinkKind, contact.value);
}

/** Small inline glyphs, decorative only — every link also carries its label. */
function ContactIcon({ kind }: { kind: PublicContact['kind'] }) {
  const path =
    kind === 'linkedin_url'
      ? 'M4 4h16v16H4z M7 10v7 M7 7v.01 M11 17v-4a2 2 0 0 1 4 0v4'
      : kind === 'github_url'
        ? 'M12 3a9 9 0 0 0-3 17.5 M12 3a9 9 0 0 1 3 17.5 M9 21v-3 M15 21v-3'
        : kind === 'website'
          ? 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18'
          : kind === 'telegram_username'
            ? 'M21 4 3 11l5 2 2 6 3-4 5 3z'
            : kind === 'whatsapp'
              ? 'M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3z M9 9c0 4 2 6 6 6'
              : 'M5 4h4l2 5-3 2a12 12 0 0 0 5 5l2-3 5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z';
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Chip row with a heading; renders nothing when there is nothing to show. */
function ChipSection({
  title,
  labels,
  accent,
  testId,
}: {
  title: string;
  labels: string[];
  accent: 'offer' | 'need' | 'interest';
  testId: string;
}) {
  if (labels.length === 0) return null;
  const className = accent === 'offer' ? 'chip-offer' : accent === 'need' ? 'chip-need' : 'chip';
  return (
    <section className="mt-6" data-testid={testId}>
      <h2 className="eyebrow">{title}</h2>
      <ul className="mt-2 flex flex-wrap gap-2">
        {labels.map((label, index) => (
          <li key={`${label}-${index}`} className={className}>
            {label}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Card sections prefer the taxonomy axes; a profile that predates them (only the
 * frozen v1 tags) still shows its tags instead of an empty card.
 */
function axisOrLegacy(
  catalog: TaxonomyCatalog,
  axis: 'need_intents' | 'offer_intents' | 'interests',
  ids: string[],
  legacy: string[],
  locale: UiLocale,
): string[] {
  return ids.length > 0 ? labelsForIds(catalog, axis, ids, locale) : legacy;
}

/**
 * The card (ONBOARDING_MINI_LANDING.md §Result). Every value here comes from the
 * public projection, which is the single place that decides what may be shown:
 * fields the owner unticked in `hidden_fields` arrive already empty, and only
 * contacts with public_enabled = true are part of `contacts` at all.
 */
export default async function PublicProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { locale, t } = await getT();
  const profile = await loadPublicProfile(slug);
  if (!profile) notFound();

  const catalog = parseCatalog(taxonomyPayload());
  // Local module, so an unusable payload is a bug — fail loudly rather than
  // render a card whose chips lost their labels.
  if (!catalog) throw new Error('taxonomy catalogue payload is unusable');
  // The public card must render for anonymous visitors and for crawlers — and
  // `cookies()` throws outside a request scope (e.g. when the page is rendered
  // directly by a test), so a failure here simply means "no viewer".
  const accountId = await getOptionalAccountId().catch(() => null);
  // The intro affordance exists only inside a shared event (mutual-consent flow):
  // a membership lookup failure must not break the public card, it just removes
  // the affordance.
  const sharedEvent = accountId
    ? await findSharedEvent(profile.slug, accountId).catch(() => null)
    : null;

  const kindLabels: Record<LinkKind, string> = {
    linkedin_url: t('contacts.kind.linkedin_url'),
    github_url: t('contacts.kind.github_url'),
    website: t('contacts.kind.website'),
    telegram_username: t('contacts.kind.telegram_username'),
    whatsapp: t('contacts.kind.whatsapp'),
  };

  const contacts = [...profile.contacts].sort(
    (a, b) => CONTACT_ORDER.indexOf(a.kind) - CONTACT_ORDER.indexOf(b.kind),
  );
  const pageUrl = `${appBaseUrl()}/p/${profile.slug}`;
  const qrUrl = `/api/public/profiles/${encodeURIComponent(profile.slug)}/qr.svg`;
  const vcardUrl = `/api/public/profiles/${encodeURIComponent(profile.slug)}/vcard`;

  // All user-controlled text is rendered as escaped React text. No HTML injection.
  return (
    <main className="mx-auto w-full max-w-xl px-5 py-10 sm:px-6">
      <article className="card" data-testid="pubcard">
        {/* Hero */}
        <header>
          <h1 className="text-3xl font-extrabold tracking-tight" data-testid="pubcard-name">
            {profile.display_name}
          </h1>
          {profile.headline ? <p className="mt-2 text-lg text-muted">{profile.headline}</p> : null}
          {profile.company ? <p className="mt-1 text-sm font-semibold text-ink">{profile.company}</p> : null}
          {profile.languages.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {profile.languages.map((language: string) => (
                <li key={language} className="chip !bg-paper !text-muted">
                  {language}
                </li>
              ))}
            </ul>
          ) : null}
          {profile.short_bio ? (
            <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-ink" data-testid="pubcard-bio">
              {profile.short_bio}
            </p>
          ) : null}
        </header>

        <ChipSection
          title={t('pubcard.helpTitle')}
          labels={axisOrLegacy(catalog, 'offer_intents', profile.offer_intents, profile.offer_tags, locale)}
          accent="offer"
          testId="pubcard-offers"
        />
        {profile.keywords.length > 0 ? (
          <section className="mt-4" data-testid="pubcard-expertise">
            <h2 className="eyebrow">{t('pubcard.expertise')}</h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {profile.keywords.map((keyword) => (
                <li key={keyword} className="chip !bg-white !text-ink border border-line">
                  {keyword}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <ChipSection
          title={t('pubcard.lookingFor')}
          labels={axisOrLegacy(catalog, 'need_intents', profile.need_intents, profile.need_tags, locale)}
          accent="need"
          testId="pubcard-needs"
        />
        <ChipSection
          title={t('pubcard.interestsTitle')}
          labels={labelsForIds(catalog, 'interests', profile.interests, locale)}
          accent="interest"
          testId="pubcard-interests"
        />

        {/* Links — public contacts only, never a private value. */}
        {contacts.length > 0 ? (
          <section className="mt-6 border-t border-line pt-5" data-testid="pubcard-links">
            <h2 className="eyebrow">{t('pubcard.contacts')}</h2>
            <ul className="mt-3 flex flex-col gap-2">
              {contacts.map((contact) => {
                const href = contactHref(contact);
                const label = kindLabels[contact.kind as LinkKind] ?? t('pubcard.contacts');
                return (
                  <li key={contact.kind} className="flex items-center gap-2 text-sm">
                    <span className="text-muted">
                      <ContactIcon kind={contact.kind} />
                    </span>
                    <span className="w-24 shrink-0 text-muted">{label}</span>
                    {href ? (
                      <a
                        className="break-all font-medium underline underline-offset-2 hover:text-ink"
                        href={href}
                        target={href.startsWith('tel:') ? undefined : '_blank'}
                        rel="noopener noreferrer nofollow"
                      >
                        {contact.value}
                      </a>
                    ) : (
                      <span className="break-all font-medium">{contact.value}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <p className="mt-6 border-t border-line pt-5 text-sm text-muted">{t('pubcard.contactsEmpty')}</p>
        )}

        {/* QR + share + vCard */}
        <div className="mt-6 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center">
          <ShareButton
            url={pageUrl}
            title={profile.display_name}
            shareLabel={t('pubcard.share')}
            copiedLabel={t('pubcard.linkCopied')}
          />
          <Link href={vcardUrl} prefetch={false} className="btn-light">
            {t('pubcard.vcard')}
          </Link>
          <Link href={qrUrl} prefetch={false} className="btn-light">
            {t('pubcard.qr')}
          </Link>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element -- SVG endpoint, no optimizer pass-through needed */}
        <img src={qrUrl} alt={t('pubcard.qr')} width={160} height={160} className="mt-4 rounded-xl border border-line bg-white p-2" />

        {sharedEvent ? (
          <IntroCta
            profileId={sharedEvent.targetProfileId}
            eventId={sharedEvent.eventId}
            displayName={profile.display_name}
            kindLabels={kindLabels}
            strings={{
              ctaIntro: t('pubcard.ctaIntro'),
              ctaIntroSent: t('pubcard.ctaIntroSent'),
              ctaIntroAlready: t('pubcard.ctaIntroAlready'),
              ctaSignIn: t('pubcard.ctaSignIn'),
              ctaSignInHint: t('pubcard.ctaSignInHint'),
              revealTitle: t('pubcard.revealTitle'),
              revealHint: t('pubcard.revealHint'),
              sendRequest: t('pubcard.sendRequest'),
              sending: t('common.saving'),
              cancel: t('common.cancel'),
              errorNetwork: t('common.errorNetwork'),
              errorGeneric: t('common.errorGeneric'),
            }}
          />
        ) : (
          <SignInCta
            href={`/login?next=/p/${profile.slug}`}
            label={t('pubcard.ctaSignIn')}
            hint={t('pubcard.ctaSignInHint')}
          />
        )}

        <p className="mt-4 text-xs text-muted">{t('pubcard.buildNote')}</p>
      </article>
    </main>
  );
}

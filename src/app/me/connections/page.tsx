import type { Metadata } from 'next';
import Link from 'next/link';
import { getT, type DictKey } from '../../../i18n';
import {
  providerById,
  type ProviderCapability,
  type ProviderDirection,
  type ProviderId,
  type ProviderKind,
} from '../../../domain/providers';
import { resolveProviders, type PublicProvider } from '../../../lib/provider-status';
import { ContactImportPanel, type ContactImportStrings } from './contact-import';

export const metadata: Metadata = { title: 'Интеграции', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * /me/connections — the "friendship with everything" page
 * (docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md §A4).
 *
 * The page is a RENDERER of the registry, never a second source of truth: the
 * cards, the statuses, the environment NAMES and the setup steps all come from
 * src/domain/providers.ts + src/lib/provider-status.ts. Adding an integration
 * therefore changes one registry row, not this file.
 *
 * Everything is server-rendered — no keys, no OAuth secrets and no status logic
 * reach the browser beyond the HTML that is already safe to show.
 */

/**
 * The one thing a user can DO for a live provider. A provider with no page of
 * its own (`email`) or one that is not built yet has no button at all: the
 * "how to connect" block is the honest answer there.
 */
const ACTIONS: Partial<Record<ProviderId, { href: string; label: DictKey }>> = {
  telegram: { href: '/me/telegram', label: 'connections.action.telegram' },
  vcard: { href: '/me', label: 'connections.action.vcard' },
  csv: { href: '/organizer', label: 'connections.action.csv' },
};

const PRIVACY_DO: readonly DictKey[] = [
  'connections.privacyDo1',
  'connections.privacyDo2',
  'connections.privacyDo3',
  'connections.privacyDo4',
];
const PRIVACY_DONT: readonly DictKey[] = [
  'connections.privacyDont1',
  'connections.privacyDont2',
  'connections.privacyDont3',
  'connections.privacyDont4',
];

/**
 * Registry ids are the contract, so the key shape is derived from them; the
 * unit suite asserts that every key built here exists in EN/RU/ES.
 */
function titleKey(id: ProviderId): DictKey {
  return `providers.${id}.title` as DictKey;
}
function descriptionKey(id: ProviderId): DictKey {
  return `providers.${id}.description` as DictKey;
}

const STATUS_CLASS: Record<string, string> = {
  live: 'chip !bg-emerald-50 !text-emerald-800',
  planned: 'chip !bg-paper !text-muted',
  disabled: 'chip !bg-amber-50 !text-amber-900',
};

export default async function ConnectionsPage() {
  const { t } = await getT();
  const providers = resolveProviders();
  const statusLabel: Record<string, DictKey> = {
    live: 'providers.status.live',
    disabled: 'providers.status.disabled',
    planned: 'providers.status.planned',
  };
  const reasonLabel: Record<string, DictKey> = {
    not_configured: 'providers.reason.not_configured',
    needs_oauth_client: 'providers.reason.needs_oauth_client',
    not_implemented: 'providers.reason.not_implemented',
    policy_restricted: 'providers.reason.policy_restricted',
    awaiting_access: 'providers.reason.awaiting_access',
  };
  const kindLabel: Record<ProviderKind, DictKey> = {
    channel: 'connections.kind.channel',
    contacts: 'connections.kind.contacts',
    calendar: 'connections.kind.calendar',
    directory: 'connections.kind.directory',
    publish: 'connections.kind.publish',
  };
  const directionLabel: Record<ProviderDirection, DictKey> = {
    out: 'connections.direction.out',
    in: 'connections.direction.in',
    both: 'connections.direction.both',
  };
  const capabilityLabel = (capability: ProviderCapability): DictKey =>
    `connections.capability.${capability}` as DictKey;

  // The import card serves BOTH contact providers (.vcf and .csv): a user has
  // one address book, so there is one panel, right under the provider list.
  const importStrings: ContactImportStrings = {
    title: t('connections.import.title'),
    subtitle: t('connections.import.subtitle'),
    fileLabel: t('connections.import.fileLabel'),
    fileHint: t('connections.import.fileHint'),
    textLabel: t('connections.import.textLabel'),
    submit: t('connections.import.submit'),
    searching: t('connections.import.searching'),
    resultSome: t('connections.import.resultSome'),
    resultOne: t('connections.import.resultOne'),
    resultNone: t('connections.import.resultNone'),
    unmatched: t('connections.import.unmatched'),
    skipped: t('connections.import.skipped'),
    matchesTruncated: t('connections.import.matchesTruncated'),
    openCard: t('connections.import.openCard'),
    note: t('connections.import.note'),
    errorNoContacts: t('connections.import.errorNoContacts'),
    errorCsv: t('connections.import.errorCsv'),
    errorTooLarge: t('connections.import.errorTooLarge'),
    errorRateLimited: t('connections.import.errorRateLimited'),
    errorGeneric: t('connections.import.errorGeneric'),
    errorUnauthorized: t('common.errorUnauthorized'),
    errorNetwork: t('common.errorNetwork'),
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-extrabold tracking-tight" data-testid="connections-title">
        {t('connections.title')}
      </h1>
      <p className="mt-1.5 text-sm text-muted">{t('connections.subtitle')}</p>

      <ul className="mt-6 flex flex-col gap-3">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            t={t}
            statusLabel={statusLabel}
            reasonLabel={reasonLabel}
            kindLabel={kindLabel}
            directionLabel={directionLabel}
            capabilityLabel={capabilityLabel}
          />
        ))}
      </ul>

      {/* One card for both contact formats: "who of my contacts is already
          here", answered without keeping a single address. */}
      <ContactImportPanel strings={importStrings} />

      {/* Honesty block: what the product does with a connection — and what it
          refuses to do, which is the reason some cards above are switched off. */}
      <section className="card mt-8" data-testid="connections-privacy">
        <h2 className="text-lg font-bold tracking-tight">{t('connections.privacyTitle')}</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <ul className="flex flex-col gap-2 text-sm">
            {PRIVACY_DO.map((key) => (
              <li key={key} className="flex gap-2">
                <span aria-hidden="true" className="text-emerald-700">
                  ✓
                </span>
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
          <ul className="flex flex-col gap-2 text-sm text-muted">
            {PRIVACY_DONT.map((key) => (
              <li key={key} className="flex gap-2">
                <span aria-hidden="true" className="text-amber-700">
                  ✕
                </span>
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-4 text-xs text-muted">{t('connections.secretsNote')}</p>
      </section>
    </div>
  );
}

function ProviderCard({
  provider,
  t,
  statusLabel,
  reasonLabel,
  kindLabel,
  directionLabel,
  capabilityLabel,
}: {
  provider: PublicProvider;
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
  statusLabel: Record<string, DictKey>;
  reasonLabel: Record<string, DictKey>;
  kindLabel: Record<ProviderKind, DictKey>;
  directionLabel: Record<ProviderDirection, DictKey>;
  capabilityLabel: (capability: ProviderCapability) => DictKey;
}) {
  // The registry row carries the design fields (kind/capabilities/steps); the
  // resolver owns the per-instance status. A registered id always has its row.
  const registered = providerById(provider.id);
  const action = provider.status === 'live' ? ACTIONS[provider.id] : undefined;
  const reason = provider.reason_code ? reasonLabel[provider.reason_code] : undefined;

  return (
    <li className="card" data-testid={`provider-${provider.id}`} data-status={provider.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold tracking-tight">{t(titleKey(provider.id))}</h2>
          <p className="mt-0.5 text-sm text-muted">{t(descriptionKey(provider.id))}</p>
        </div>
        <span className={STATUS_CLASS[provider.status] ?? 'chip'} data-testid={`provider-status-${provider.id}`}>
          {t(statusLabel[provider.status] ?? 'providers.status.disabled')}
        </span>
      </div>

      {/* Honest state: an unavailable provider says why, in one sentence. */}
      {reason ? (
        <p className="mt-3 text-sm text-amber-900" data-testid={`provider-reason-${provider.id}`}>
          {t(reason, { env: provider.missing_env.join(', ') })}
        </p>
      ) : null}

      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <div>
          <dt className="inline font-semibold">{t('connections.kindLabel')}: </dt>
          <dd className="inline">{t(kindLabel[provider.kind])}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">{t('connections.directionLabel')}: </dt>
          <dd className="inline">{t(directionLabel[provider.direction])}</dd>
        </div>
        <div data-testid={`provider-capabilities-${provider.id}`}>
          <dt className="inline font-semibold">{t('connections.capabilitiesLabel')}: </dt>
          <dd className="inline">{provider.capabilities.map((c) => t(capabilityLabel(c))).join(' · ')}</dd>
        </div>
      </dl>

      {/* "How to connect": steps and env NAMES, straight from the registry. */}
      <details className="mt-3 rounded-xl bg-paper px-4 py-3" data-testid={`provider-setup-${provider.id}`}>
        <summary className="cursor-pointer text-sm font-semibold">{t('connections.setupSummary')}</summary>
        {registered ? (
          <div className="mt-2 flex flex-col gap-2 text-xs text-muted">
            <ol className="flex flex-col gap-1.5">
              {registered.setup.steps.map((key, index) => (
                <li key={key}>
                  {index + 1}. {t(key)}
                </li>
              ))}
            </ol>
            <p data-testid={`provider-env-${provider.id}`}>
              <span className="font-semibold">{t('connections.envLabel')}: </span>
              {registered.setup.env.length > 0 ? registered.setup.env.join(', ') : t('connections.envNone')}
            </p>
          </div>
        ) : null}
      </details>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="text-xs uppercase tracking-wide text-muted">{t('connections.actionLabel')}</span>
        {action ? (
          <Link href={action.href} className="btn-light btn-small" data-testid={`provider-action-${provider.id}`}>
            {t(action.label)}
          </Link>
        ) : (
          <span className="btn-light btn-small cursor-not-allowed opacity-60" aria-disabled="true">
            {t('connections.action.none')}
          </span>
        )}
      </div>
    </li>
  );
}

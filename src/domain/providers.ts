/**
 * Provider registry — ONE place that declares a social/contacts/calendar
 * integration (`docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md` §A2/§A3).
 *
 * Adding an integration is "one file + one registry row" (A1.5), so every row
 * here is data, never code: the UI renders the connections page and the
 * "how to connect" block straight from this list, and `GET /api/providers`
 * projects it for anyone who needs the machine-readable version.
 *
 * Non-negotiables carried by the shape of the type:
 *
 *   - `auth` is the only way in: an integration with no official API can never
 *     claim more than a deeplink (`auth: 'deeplink'` + `capabilities:
 *     ['deeplink']`), which is what makes "no scraping" (A1.2) structural
 *     rather than a comment;
 *   - `setup.env` holds VARIABLE NAMES only. Values are read at request time by
 *     the resolver (src/lib/provider-status.ts) and never stored, logged or
 *     returned — that is why the registry can be public;
 *   - `setup.steps` are i18n KEYS, not sentences: the domain stays text-free
 *     (same rule as src/domain/reasons.ts), so the connections page renders in
 *     EN/RU/ES without a second vocabulary;
 *   - `status` is the design's ceiling for the provider ('planned' = not built
 *     yet, 'disabled' = deliberately off), while the LIVE status of an
 *     instance is resolved from the environment, so an unconfigured Telegram is
 *     reported honestly instead of silently missing (A4 «Честные состояния»).
 *
 * Documented deviations from the §A2 sketch (both additive, both required by
 * the §A3 table itself, which is the authoritative list):
 *
 *   1. `ProviderAuth` gains `'deeplink'` — the WhatsApp row is `auth deeplink`,
 *      a value the §A2 union does not list;
 *   2. `ProviderId` gains `'share-deeplinks'` — the §A3 "Share-deeplinks" row has
 *      no id in the §A2 union. `'notion'` stays in the union (declared identity)
 *      but has no §A3 row, so it is deliberately NOT registered below.
 *   3. `reason_code` is an extra registry field: §A4 requires a card to say WHY
 *      a provider is unavailable, and the reason belongs with the declaration.
 *   4. The §A3 "Microsoft People/Calendar" row covers two kinds; the contract's
 *      `kind` is single-valued, so the row is registered as `contacts`
 *      (People API) with the calendar half documented as Phase 2 work.
 *   5. `ProviderCapability` gains `'match'` — "find who of my contacts is
 *      already here", the one thing an address book can do without any OAuth
 *      client (POST /api/me/contacts/import). It is neither inbound nor
 *      outbound data flow, so it does not enter the `direction` reading below.
 *   6. PHASE 2 narrows the two Google rows' capabilities to what the provisioned
 *      OAuth client can actually grant, and marks them `live` (env-gated). §A3
 *      listed Google Contacts as `import, export` and Google Calendar as
 *      `import, export`; the client is scoped `contacts.readonly` +
 *      `calendar.events`, so a contacts write-back and a calendar read are both
 *      impossible. A live row claiming them would be a false statement in the UI
 *      ("What it can do"), so `google-contacts` declares `import, match` and
 *      `google-calendar` declares `export`. Re-adding either half means adding
 *      the corresponding Google scope — a consent-screen change, not a code
 *      change. Recorded in docs-internal/product/GOOGLE_OAUTH_SETUP.md.
 */

import type { DictKey } from '../i18n/en';

export type ProviderId =
  | 'telegram'
  | 'whatsapp'
  | 'email'
  | 'google-contacts'
  | 'google-calendar'
  | 'microsoft-people'
  | 'linkedin'
  | 'github'
  | 'instagram'
  | 'x'
  | 'vcard'
  | 'ics'
  | 'csv'
  | 'luma'
  | 'notion'
  | 'share-deeplinks';

export type ProviderKind = 'channel' | 'contacts' | 'calendar' | 'directory' | 'publish';

/** `deeplink` = no API, the user's own click carries the action (see header). */
export type ProviderAuth = 'oauth' | 'bot' | 'api-key' | 'none' | 'deeplink';

export type ProviderCapability = 'send' | 'receive' | 'import' | 'export' | 'publish' | 'deeplink' | 'match';

export type ProviderDirection = 'out' | 'in' | 'both';

/** Design status: what this build does with the provider. */
export type ProviderStatus = 'live' | 'disabled' | 'planned';

/**
 * Machine-readable "why it is not available" — the UI localizes it
 * (`providers.reason.*`), so the registry never ships a sentence.
 */
export type ProviderReasonCode =
  /** Live-capable, but this instance lacks the required env (missing_env names it). */
  | 'not_configured'
  /** Planned: needs OUR OAuth client before it can be switched on (Phase 2). */
  | 'needs_oauth_client'
  /** Planned: not built yet in this phase. */
  | 'not_implemented'
  /** Disabled on purpose: an API/ToS decision, not a missing key. */
  | 'policy_restricted'
  /** Disabled: waiting for access from the vendor. */
  | 'awaiting_access';

export interface ProviderSetup {
  /** Environment VARIABLE NAMES (never values). Displayed in "how to connect". */
  readonly env: readonly string[];
  /** i18n keys for the setup steps, rendered by the connections page. */
  readonly steps: readonly DictKey[];
}

export interface Provider {
  readonly id: ProviderId;
  readonly kind: ProviderKind;
  readonly auth: ProviderAuth;
  readonly capabilities: readonly ProviderCapability[];
  readonly direction: ProviderDirection;
  readonly status: ProviderStatus;
  readonly reason_code: ProviderReasonCode | null;
  readonly setup: ProviderSetup;
}

/**
 * §A3 rows, in table order. `direction` is the table's capability set read as a
 * data flow (send/publish/export/deeplink → out, receive/import → in); `match`
 * moves no data either way — it answers a question about the address book the
 * user already owns — so it never decides a direction.
 */
export const PROVIDERS: readonly Provider[] = Object.freeze([
  {
    id: 'telegram',
    kind: 'channel',
    auth: 'bot',
    capabilities: ['send', 'receive', 'deeplink'],
    direction: 'both',
    status: 'live',
    reason_code: null,
    setup: { env: ['TELEGRAM_BOT_TOKEN'], steps: ['providers.telegram.step1', 'providers.telegram.step2'] },
  },
  {
    id: 'email',
    kind: 'channel',
    auth: 'api-key',
    capabilities: ['send'],
    direction: 'out',
    status: 'live',
    reason_code: null,
    setup: { env: ['RESEND_API_KEY'], steps: ['providers.email.step1', 'providers.email.step2'] },
  },
  {
    id: 'vcard',
    kind: 'contacts',
    auth: 'none',
    capabilities: ['import', 'export', 'match'],
    direction: 'both',
    status: 'live',
    reason_code: null,
    setup: { env: [], steps: ['providers.vcard.step1'] },
  },
  {
    id: 'csv',
    kind: 'contacts',
    auth: 'none',
    capabilities: ['import', 'export', 'match'],
    direction: 'both',
    status: 'live',
    reason_code: null,
    setup: { env: [], steps: ['providers.csv.step1'] },
  },
  {
    id: 'ics',
    kind: 'calendar',
    auth: 'none',
    capabilities: ['export', 'deeplink'],
    direction: 'out',
    status: 'planned',
    reason_code: 'not_implemented',
    setup: { env: [], steps: ['providers.ics.step1'] },
  },
  {
    id: 'share-deeplinks',
    kind: 'publish',
    auth: 'none',
    capabilities: ['publish'],
    direction: 'out',
    status: 'planned',
    reason_code: 'not_implemented',
    setup: { env: [], steps: ['providers.share-deeplinks.step1'] },
  },
  {
    id: 'google-contacts',
    kind: 'contacts',
    auth: 'oauth',
    // Phase 2 reads the user's connections through `people/me/connections` and
    // MATCHES them in memory — the same question the .vcf/.csv import answers.
    // `export` ("push chosen contacts back") is deliberately NOT declared: the
    // provisioned OAuth client is scoped `contacts.readonly`, so a write-back is
    // impossible, and a `live` row claiming a capability the client cannot grant
    // would be exactly the kind of pretending the registry exists to prevent.
    capabilities: ['import', 'match'],
    direction: 'in',
    status: 'live',
    reason_code: null,
    setup: {
      env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
      steps: ['providers.google-contacts.step1', 'providers.google-contacts.step2'],
    },
  },
  {
    id: 'google-calendar',
    kind: 'calendar',
    auth: 'oauth',
    // Phase 2 WRITES one event into the user's own calendar. `import` (reading
    // their calendar) is not declared and not requested: `calendar.events` is the
    // only Calendar scope on the client, and it cannot list events.
    capabilities: ['export'],
    direction: 'out',
    status: 'live',
    reason_code: null,
    setup: {
      env: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
      steps: ['providers.google-calendar.step1', 'providers.google-calendar.step2'],
    },
  },
  {
    id: 'microsoft-people',
    kind: 'contacts',
    auth: 'oauth',
    capabilities: ['import', 'export'],
    direction: 'both',
    status: 'planned',
    reason_code: 'needs_oauth_client',
    setup: {
      env: ['MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET'],
      steps: ['providers.microsoft-people.step1', 'providers.microsoft-people.step2'],
    },
  },
  {
    id: 'github',
    kind: 'contacts',
    auth: 'oauth',
    capabilities: ['import'],
    direction: 'in',
    status: 'planned',
    reason_code: 'needs_oauth_client',
    setup: {
      env: ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET'],
      steps: ['providers.github.step1', 'providers.github.step2'],
    },
  },
  {
    id: 'linkedin',
    kind: 'publish',
    auth: 'oauth',
    capabilities: ['publish'],
    direction: 'out',
    status: 'disabled',
    reason_code: 'policy_restricted',
    setup: {
      env: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
      steps: ['providers.linkedin.step1'],
    },
  },
  {
    id: 'whatsapp',
    kind: 'channel',
    auth: 'deeplink',
    capabilities: ['deeplink', 'send'],
    direction: 'out',
    status: 'planned',
    reason_code: 'not_implemented',
    setup: { env: [], steps: ['providers.whatsapp.step1'] },
  },
  {
    id: 'instagram',
    kind: 'publish',
    auth: 'none',
    capabilities: ['publish'],
    direction: 'out',
    status: 'disabled',
    reason_code: 'policy_restricted',
    setup: { env: [], steps: ['providers.instagram.step1'] },
  },
  {
    id: 'x',
    kind: 'publish',
    auth: 'none',
    capabilities: ['publish'],
    direction: 'out',
    status: 'disabled',
    reason_code: 'policy_restricted',
    setup: { env: [], steps: ['providers.x.step1'] },
  },
  {
    id: 'luma',
    kind: 'directory',
    auth: 'api-key',
    capabilities: ['import'],
    direction: 'in',
    status: 'disabled',
    reason_code: 'awaiting_access',
    setup: { env: ['LUMA_API_KEY'], steps: ['providers.luma.step1'] },
  },
] satisfies readonly Provider[]);

/**
 * The env a provider's LIVE status actually depends on — the honest per-instance
 * switch, and the only thing that can turn a `live` row into a `disabled` one.
 *
 * Four providers are instance-configurable: the two channel providers (bot
 * token, mail key) and, since Phase 2, the two Google rows — which share the
 * SAME pair of variables, because they share one OAuth client. Everything else
 * is either audience-independent (vcard/csv) or not built yet. Keeping the gate
 * here (and not in `setup.env`, which also lists optional variables) means the
 * resolver can name exactly what is missing.
 *
 * A `planned` / `disabled` row can NOT be switched on by configuration: those
 * are design states, and `resolveProviderStatus` only consults this map for rows
 * whose registry status is already `live`.
 */
export const REQUIRED_ENV: Partial<Record<ProviderId, readonly string[]>> = Object.freeze({
  telegram: Object.freeze(['TELEGRAM_BOT_TOKEN']),
  email: Object.freeze(['RESEND_API_KEY']),
  'google-contacts': Object.freeze(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']),
  'google-calendar': Object.freeze(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']),
});

/** Provider ids in registry (table) order — the connections page renders this. */
export const PROVIDER_IDS: readonly ProviderId[] = Object.freeze(PROVIDERS.map((p) => p.id));

const BY_ID = new Map<ProviderId, Provider>(PROVIDERS.map((p) => [p.id, p]));

/** Registry lookup; `null` for a declared-but-unregistered id (e.g. 'notion'). */
export function providerById(id: ProviderId): Provider | null {
  return BY_ID.get(id) ?? null;
}

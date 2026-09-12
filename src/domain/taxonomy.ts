/**
 * WELCOME taxonomy v3 — the single source of truth for the three matching axes
 * (docs-internal/taxonomy/TAXONOMY_V3.md):
 *
 *   1. INTENT   — 16 complementary need/offer pairs ("кого я ищу и кем полезен");
 *                 a match exists when A needs X and B offers complement(X).
 *   2. INTEREST — curated catalogue of ~90 shared topics ("про что интересно").
 *   3. FUNCTION / INDUSTRY — professional context, single select each.
 *
 * Plus free-form KEYWORDS (<=5, <=40 chars) — nuance and search input, never a gate.
 *
 * This module is pure data + pure functions: no DB, no network, no locale state.
 * Every id stored in the DB is validated here, so the catalogue is the only
 * place that has to change when the vocabulary grows.
 *
 * Aliases (RU/EN spellings + the legacy v1 tag ids) exist so write-time
 * normalization keeps the frozen `scorePair` core untouched and so the
 * tag→v3 data migration can map old rows without losing data.
 */

export type Locale = 'ru' | 'en';

export interface Labels {
  readonly ru: string;
  readonly en: string;
}

/** Structural twin of `Validated<T>` in domain/profile.ts (no import cycle). */
export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// Limits (enforced by the validators below and mirrored in the UI)
// ---------------------------------------------------------------------------

export const MAX_NEED_INTENTS = 3;
export const MAX_OFFER_INTENTS = 3;
export const MAX_INTERESTS = 5;
export const MAX_KEYWORDS = 5;
export const MAX_KEYWORD_LENGTH = 40;

/** Explicit "decline to answer" value for function/industry (privacy note in
 * TAXONOMY_V3.md). Accepted on input, normalized to NULL in the DB. */
export const PREFER_NOT_TO_SAY = 'prefer-not-to-say';

// ---------------------------------------------------------------------------
// Axis 3 — function + industry (single select)
// ---------------------------------------------------------------------------

export interface FacetDef {
  readonly id: string;
  readonly label: Labels;
}

export interface IntentSideDef {
  readonly id: string;
  readonly kind: 'need' | 'offer';
  /** Chip text shown in the picker. */
  readonly label: Labels;
  /** Sentence fragment used by the human reasons (see networking-score.ts). */
  readonly goal: Labels;
}

export interface IntentPairDef {
  readonly id: string;
  readonly need: IntentSideDef;
  readonly offer: IntentSideDef;
}

export const JOB_FUNCTIONS: readonly FacetDef[] = [
  { id: 'founder-ceo', label: { ru: 'Основатель / CEO', en: 'Founder / CEO' } },
  { id: 'c-level-other', label: { ru: 'Другой C-level', en: 'Other C-level' } },
  { id: 'product', label: { ru: 'Продукт', en: 'Product' } },
  { id: 'design', label: { ru: 'Дизайн', en: 'Design' } },
  { id: 'engineering', label: { ru: 'Разработка', en: 'Engineering' } },
  { id: 'data-ai', label: { ru: 'Данные и AI', en: 'Data / AI' } },
  { id: 'marketing', label: { ru: 'Маркетинг', en: 'Marketing' } },
  { id: 'sales-bd', label: { ru: 'Продажи и BD', en: 'Sales / BD' } },
  { id: 'finance', label: { ru: 'Финансы', en: 'Finance' } },
  { id: 'operations', label: { ru: 'Операции', en: 'Operations' } },
  { id: 'hr-people', label: { ru: 'HR и люди', en: 'HR / People' } },
  { id: 'legal', label: { ru: 'Юридический', en: 'Legal' } },
  { id: 'investor', label: { ru: 'Инвестор', en: 'Investor' } },
  { id: 'student', label: { ru: 'Студент', en: 'Student' } },
];

export const INDUSTRIES: readonly FacetDef[] = [
  { id: 'ai-saas', label: { ru: 'AI и SaaS', en: 'AI / SaaS' } },
  { id: 'fintech', label: { ru: 'Финтех', en: 'Fintech' } },
  { id: 'ecommerce-retail', label: { ru: 'E-commerce и ритейл', en: 'E-commerce / retail' } },
  { id: 'education', label: { ru: 'Образование', en: 'Education' } },
  { id: 'health-beauty', label: { ru: 'Здоровье и красота', en: 'Health / beauty' } },
  { id: 'real-estate', label: { ru: 'Недвижимость', en: 'Real estate' } },
  { id: 'logistics', label: { ru: 'Логистика', en: 'Logistics' } },
  { id: 'media-content', label: { ru: 'Медиа и контент', en: 'Media / content' } },
  { id: 'manufacturing', label: { ru: 'Производство', en: 'Manufacturing' } },
  { id: 'public-sector', label: { ru: 'Госсектор', en: 'Public sector' } },
  { id: 'horeca-tourism', label: { ru: 'HoReCa и туризм', en: 'HoReCa / tourism' } },
  { id: 'other', label: { ru: 'Другое', en: 'Other' } },
];

/** Function pairs that read as complementary in a professional context
 * (TAXONOMY_V3.md: founder↔investor, sales↔marketing). */
export const COMPLEMENTARY_FUNCTIONS: readonly (readonly [string, string])[] = [
  ['founder-ceo', 'investor'],
  ['sales-bd', 'marketing'],
];

// ---------------------------------------------------------------------------
// Axis 1 — INTENT: 16 complementary need/offer pairs
// ---------------------------------------------------------------------------

export const INTENTS: readonly IntentPairDef[] = [
  {
    id: 'cofounder',
    need: {
      id: 'seeking-cofounder',
      kind: 'need',
      label: { ru: 'Ищу со-фаундера', en: 'Looking for a co-founder' },
      goal: { ru: 'со-фаундера', en: 'a co-founder' },
    },
    offer: {
      id: 'open-to-cofound',
      kind: 'offer',
      label: { ru: 'Готов быть со-фаундером', en: 'Open to co-founding' },
      goal: { ru: 'открыты к со-фаундерству', en: 'open to co-founding' },
    },
  },
  {
    id: 'hiring',
    need: {
      id: 'hiring',
      kind: 'need',
      label: { ru: 'Ищу сотрудников', en: 'Hiring' },
      goal: { ru: 'сотрудников', en: 'to hire' },
    },
    offer: {
      id: 'open-to-work',
      kind: 'offer',
      label: { ru: 'Открыты к предложениям о работе', en: 'Open to work' },
      goal: { ru: 'открыты к предложениям о работе', en: 'open to work' },
    },
  },
  {
    id: 'clients',
    need: {
      id: 'seeking-clients',
      kind: 'need',
      label: { ru: 'Ищу клиентов', en: 'Looking for clients' },
      goal: { ru: 'клиентов', en: 'clients' },
    },
    offer: {
      id: 'offering-services',
      kind: 'offer',
      label: { ru: 'Предлагаю услуги', en: 'Offering services' },
      goal: { ru: 'предлагаете услуги', en: 'offer services' },
    },
  },
  {
    id: 'partner',
    need: {
      id: 'seeking-partner',
      kind: 'need',
      label: { ru: 'Ищу бизнес-партнёра', en: 'Looking for a business partner' },
      goal: { ru: 'бизнес-партнёра', en: 'a business partner' },
    },
    offer: {
      id: 'open-to-partner',
      kind: 'offer',
      label: { ru: 'Открыты к партнёрству', en: 'Open to partnering' },
      goal: { ru: 'открыты к партнёрству', en: 'open to partnering' },
    },
  },
  {
    id: 'investment',
    need: {
      id: 'seeking-investment',
      kind: 'need',
      label: { ru: 'Ищу инвестиции', en: 'Raising investment' },
      goal: { ru: 'инвестиции', en: 'investment' },
    },
    offer: {
      id: 'investing',
      kind: 'offer',
      label: { ru: 'Инвестирую', en: 'Investing' },
      goal: { ru: 'инвестируете', en: 'invest' },
    },
  },
  {
    id: 'mentor',
    need: {
      id: 'seeking-mentor',
      kind: 'need',
      label: { ru: 'Ищу ментора', en: 'Looking for a mentor' },
      goal: { ru: 'ментора', en: 'a mentor' },
    },
    offer: {
      id: 'mentoring',
      kind: 'offer',
      label: { ru: 'Готов менторить', en: 'Open to mentoring' },
      goal: { ru: 'готовы менторить', en: 'open to mentoring' },
    },
  },
  {
    id: 'expertise',
    need: {
      id: 'seeking-expertise',
      kind: 'need',
      label: { ru: 'Нужен экспертный совет', en: 'Need expert advice' },
      goal: { ru: 'экспертный совет', en: 'expert advice' },
    },
    offer: {
      id: 'advising',
      kind: 'offer',
      label: { ru: 'Готов консультировать', en: 'Available to advise' },
      goal: { ru: 'готовы консультировать', en: 'available to advise' },
    },
  },
  {
    id: 'pilot',
    need: {
      id: 'seeking-pilot-users',
      kind: 'need',
      label: { ru: 'Ищу пилотных пользователей', en: 'Looking for pilot users' },
      goal: { ru: 'пилотных пользователей', en: 'pilot users' },
    },
    offer: {
      id: 'pilot-ready',
      kind: 'offer',
      label: { ru: 'Готов потестировать', en: 'Ready to pilot' },
      goal: { ru: 'готовы потестировать', en: 'ready to pilot' },
    },
  },
  {
    id: 'distribution',
    need: {
      id: 'seeking-distribution',
      kind: 'need',
      label: { ru: 'Ищу канал дистрибуции', en: 'Looking for distribution' },
      goal: { ru: 'канал дистрибуции', en: 'distribution channels' },
    },
    offer: {
      id: 'distribution-ready',
      kind: 'offer',
      label: { ru: 'Есть каналы дистрибуции', en: 'Have distribution channels' },
      goal: { ru: 'есть каналы дистрибуции', en: 'have distribution channels' },
    },
  },
  {
    id: 'team',
    need: {
      id: 'seeking-team',
      kind: 'need',
      label: { ru: 'Собираю команду', en: 'Building a team' },
      goal: { ru: 'команду', en: 'a team' },
    },
    offer: {
      id: 'open-to-project',
      kind: 'offer',
      label: { ru: 'Открыты к проектам', en: 'Open to projects' },
      goal: { ru: 'открыты к проектам', en: 'open to projects' },
    },
  },
  {
    id: 'community',
    need: {
      id: 'seeking-community',
      kind: 'need',
      label: { ru: 'Ищу комьюнити', en: 'Looking for a community' },
      goal: { ru: 'комьюнити', en: 'a community' },
    },
    offer: {
      id: 'community-host',
      kind: 'offer',
      label: { ru: 'Веду комьюнити', en: 'Host a community' },
      goal: { ru: 'ведёте комьюнити', en: 'host a community' },
    },
  },
  {
    id: 'vendor',
    need: {
      id: 'seeking-vendor',
      kind: 'need',
      label: { ru: 'Ищу подрядчика', en: 'Looking for a vendor' },
      goal: { ru: 'подрядчика', en: 'a vendor' },
    },
    offer: {
      id: 'offering-vendor-services',
      kind: 'offer',
      label: { ru: 'Оказываю услуги подрядчика', en: 'Offer vendor services' },
      goal: { ru: 'оказываете услуги подрядчика', en: 'offer vendor services' },
    },
  },
  {
    id: 'venue',
    need: {
      id: 'seeking-venue',
      kind: 'need',
      label: { ru: 'Ищу площадку', en: 'Looking for a venue' },
      goal: { ru: 'площадку', en: 'a venue' },
    },
    offer: {
      id: 'offering-venue',
      kind: 'offer',
      label: { ru: 'Есть площадка', en: 'Have a venue' },
      goal: { ru: 'есть площадка', en: 'have a venue' },
    },
  },
  {
    id: 'feedback',
    need: {
      id: 'seeking-feedback',
      kind: 'need',
      label: { ru: 'Ищу обратную связь', en: 'Looking for feedback' },
      goal: { ru: 'обратную связь', en: 'feedback' },
    },
    offer: {
      id: 'offering-feedback',
      kind: 'offer',
      label: { ru: 'Готов дать фидбек', en: 'Happy to give feedback' },
      goal: { ru: 'готовы дать фидбек', en: 'happy to give feedback' },
    },
  },
  {
    id: 'supplier',
    need: {
      id: 'seeking-supplier',
      kind: 'need',
      label: { ru: 'Ищу поставщика', en: 'Looking for a supplier' },
      goal: { ru: 'поставщика', en: 'a supplier' },
    },
    offer: {
      id: 'supplying-services',
      kind: 'offer',
      label: { ru: 'Поставляю товары и услуги', en: 'Supply goods / services' },
      goal: { ru: 'поставляете товары и услуги', en: 'supply goods and services' },
    },
  },
  {
    id: 'fund-cofounder',
    need: {
      id: 'seeking-cofounder-for-fund',
      kind: 'need',
      label: { ru: 'Ищу со-фаундера для фонда', en: 'Looking for a fund co-founder' },
      goal: { ru: 'со-фаундера для фонда', en: 'a fund co-founder' },
    },
    offer: {
      id: 'investing-in-funds',
      kind: 'offer',
      label: { ru: 'Инвестирую в фонды', en: 'Invest in funds' },
      goal: { ru: 'инвестируете в фонды', en: 'invest in funds' },
    },
  },
];

const INTENT_SIDES: readonly IntentSideDef[] = INTENTS.flatMap((p) => [p.need, p.offer]);
const INTENT_BY_ID = new Map<string, IntentSideDef>(INTENT_SIDES.map((i) => [i.id, i]));
/** Catalogue position per intent id — reasons are emitted in this stable order. */
const INTENT_ORDER = new Map<string, number>(INTENT_SIDES.map((i, idx) => [i.id, idx]));

export const INTENT_IDS: readonly string[] = INTENT_SIDES.map((i) => i.id);
export const NEED_INTENT_IDS: readonly string[] = INTENTS.map((p) => p.need.id);
export const OFFER_INTENT_IDS: readonly string[] = INTENTS.map((p) => p.offer.id);

const COMPLEMENT = new Map<string, string>(
  INTENTS.flatMap((p) => [
    [p.need.id, p.offer.id],
    [p.offer.id, p.need.id],
  ]),
);

/** The complementary intent id, or null for unknown ids. Symmetric. */
export function complementOf(intentId: string): string | null {
  return COMPLEMENT.get(intentId) ?? null;
}

export function isIntentId(id: unknown): id is string {
  return typeof id === 'string' && INTENT_BY_ID.has(id);
}

export function intentById(intentId: string): IntentSideDef | null {
  return INTENT_BY_ID.get(intentId) ?? null;
}

export function intentKind(intentId: string): 'need' | 'offer' | null {
  return INTENT_BY_ID.get(intentId)?.kind ?? null;
}

export function intentLabel(intentId: string, locale: Locale): string | null {
  const side = INTENT_BY_ID.get(intentId);
  return side ? side.label[locale] : null;
}

export function intentOrder(intentId: string): number {
  return INTENT_ORDER.get(intentId) ?? Number.MAX_SAFE_INTEGER;
}

/** Intent ids of one side, in catalogue order. */
export function intentIdsOfKind(kind: 'need' | 'offer'): readonly string[] {
  return kind === 'need' ? NEED_INTENT_IDS : OFFER_INTENT_IDS;
}

// ---------------------------------------------------------------------------
// Axis 2 — INTEREST catalogue (grouped; shared-overlap semantics)
// ---------------------------------------------------------------------------

export interface InterestGroupDef {
  readonly id: string;
  readonly label: Labels;
}

export interface InterestDef {
  readonly id: string;
  readonly group: string;
  readonly label: Labels;
  /** RU/EN spellings and legacy v1 tag ids that normalize to this interest. */
  readonly aliases: readonly string[];
}

export const INTEREST_GROUPS: readonly InterestGroupDef[] = [
  { id: 'tech', label: { ru: 'Технологии и диджитал', en: 'Tech & digital' } },
  { id: 'startups', label: { ru: 'Стартапы и бизнес', en: 'Startups & business' } },
  { id: 'growth', label: { ru: 'Маркетинг и рост', en: 'Marketing & growth' } },
  { id: 'sales', label: { ru: 'Продажи и развитие', en: 'Sales & BD' } },
  { id: 'product', label: { ru: 'Продукт и дизайн', en: 'Product & design' } },
  { id: 'finance', label: { ru: 'Финансы и инвестиции', en: 'Finance & investment' } },
  { id: 'people', label: { ru: 'Люди и лидерство', en: 'People & leadership' } },
  { id: 'health', label: { ru: 'Здоровье и wellbeing', en: 'Health & wellness' } },
  { id: 'beauty', label: { ru: 'Красота и мода', en: 'Beauty & fashion' } },
  { id: 'education', label: { ru: 'Образование и наука', en: 'Education & science' } },
  { id: 'sustainability', label: { ru: 'Устойчивость и импакт', en: 'Sustainability & impact' } },
  { id: 'lifestyle', label: { ru: 'Лайфстайл и культура', en: 'Lifestyle & culture' } },
  { id: 'local', label: { ru: 'Локальное сообщество', en: 'Local & community' } },
  { id: 'industry-ties', label: { ru: 'Отраслевые связи', en: 'Industry ties' } },
];

export const INTERESTS: readonly InterestDef[] = [
  // --- Tech & digital -------------------------------------------------------
  {
    id: 'ai-ml',
    group: 'tech',
    label: { ru: 'AI и ML', en: 'AI / ML' },
    aliases: ['ai', 'ml', 'ии', 'искусственный интеллект', 'машинное обучение', 'нейросети', 'ai-transformation', 'applied-ai', 'ml-engineering', 'rag-systems', 'ai трансформация'],
  },
  { id: 'saas', group: 'tech', label: { ru: 'SaaS', en: 'SaaS' }, aliases: ['saas-сервис', 'облачный сервис', 'b2b saas'] },
  {
    id: 'dev-tools',
    group: 'tech',
    label: { ru: 'Dev-инструменты', en: 'Dev tools' },
    aliases: ['devtools', 'dev tools', 'инструменты разработчика', 'mcp', 'mcp-integrations', 'api', 'sdk', 'agents', 'агенты', 'frontend', 'backend', 'fullstack', 'mobile', 'devops', 'qa-testing'],
  },
  {
    id: 'automation',
    group: 'tech',
    label: { ru: 'Автоматизация', en: 'Automation' },
    aliases: ['автоматизация', 'автоматизация процессов', 'ai-automation', 'workflow automation'],
  },
  {
    id: 'data-analytics',
    group: 'tech',
    label: { ru: 'Данные и аналитика', en: 'Data & analytics' },
    aliases: ['данные', 'аналитика', 'data', 'analytics', 'bi', 'dwh', 'data-platforms', 'big data', 'дашборды'],
  },
  { id: 'cybersecurity', group: 'tech', label: { ru: 'Кибербезопасность', en: 'Cybersecurity' }, aliases: ['кибербезопасность', 'безопасность', 'security', 'infosec', 'иб'] },
  { id: 'web3-crypto', group: 'tech', label: { ru: 'Web3 и крипто', en: 'Web3 / crypto' }, aliases: ['web3', 'крипто', 'криптовалюта', 'криптовалюты', 'blockchain', 'блокчейн', 'crypto', 'defi'] },
  { id: 'ar-vr', group: 'tech', label: { ru: 'AR и VR', en: 'AR / VR' }, aliases: ['ar', 'vr', 'xr', 'дополненная реальность', 'виртуальная реальность', 'метавселенная'] },
  { id: 'robotics-hardware', group: 'tech', label: { ru: 'Робототехника и железо', en: 'Robotics / hardware' }, aliases: ['робототехника', 'robotics', 'hardware', 'железо', 'iot', 'устройства', 'дроны'] },
  { id: 'no-code', group: 'tech', label: { ru: 'No-code', en: 'No-code' }, aliases: ['nocode', 'no code', 'low-code', 'без кода', 'конструкторы'] },

  // --- Startups & business ---------------------------------------------------
  { id: 'startups', group: 'startups', label: { ru: 'Стартапы', en: 'Startups' }, aliases: ['стартап', 'стартапы', 'startup', 'венчурные стартапы'] },
  {
    id: 'fundraising',
    group: 'startups',
    label: { ru: 'Привлечение инвестиций', en: 'Fundraising' },
    aliases: ['фандрайзинг', 'привлечение инвестиций', 'funding', 'инвестиции', 'seed', 'seed-money', 'посевные инвестиции', 'раунд', 'гранты', 'grants', 'питч', 'pitch'],
  },
  { id: 'venture-capital', group: 'startups', label: { ru: 'Венчурный капитал', en: 'Venture capital' }, aliases: ['венчур', 'венчурный капитал', 'vc', 'venture', 'venture capital', 'investor-intros', 'инвесторы'] },
  { id: 'bootstrapping', group: 'startups', label: { ru: 'Бутстрап', en: 'Bootstrapping' }, aliases: ['бутстрап', 'bootstrap', 'без инвестиций', 'self-funded'] },
  { id: 'marketplaces', group: 'startups', label: { ru: 'Маркетплейсы', en: 'Marketplaces' }, aliases: ['маркетплейс', 'маркетплейсы', 'marketplace', 'платформа', 'двусторонний рынок'] },
  { id: 'entrepreneurship', group: 'startups', label: { ru: 'Предпринимательство', en: 'Entrepreneurship' }, aliases: ['предпринимательство', 'бизнес', 'entrepreneur', 'основатель бизнеса'] },
  { id: 'franchising', group: 'startups', label: { ru: 'Франшизы', en: 'Franchising' }, aliases: ['франшиза', 'франчайзинг', 'franchise'] },
  { id: 'family-business', group: 'startups', label: { ru: 'Семейный бизнес', en: 'Family business' }, aliases: ['семейный бизнес', 'family business', 'семейное дело'] },
  { id: 'exits-ma', group: 'startups', label: { ru: 'Сделки M&A', en: 'Exits / M&A' }, aliases: ['m&a', 'mna', 'слияния и поглощения', 'exit', 'exits', 'продажа бизнеса'] },
  { id: 'small-business', group: 'startups', label: { ru: 'Малый бизнес', en: 'Small business' }, aliases: ['малый бизнес', 'смб', 'small business', 'smb', 'локальный бизнес'] },

  // --- Marketing & growth ----------------------------------------------------
  {
    id: 'performance-marketing',
    group: 'growth',
    label: { ru: 'Перформанс-маркетинг', en: 'Performance marketing' },
    aliases: ['перформанс', 'перформанс-маркетинг', 'performance', 'marketing', 'маркетинг', 'growth', 'growth hacking', 'реклама', 'продвижение'],
  },
  { id: 'brand', group: 'growth', label: { ru: 'Бренд', en: 'Brand' }, aliases: ['бренд', 'брендинг', 'brand', 'branding', 'айдентика'] },
  { id: 'content-seo', group: 'growth', label: { ru: 'Контент и SEO', en: 'Content / SEO' }, aliases: ['контент', 'seo', 'контент-маркетинг', 'content', 'копирайтинг', 'статьи', 'блог'] },
  { id: 'social-media', group: 'growth', label: { ru: 'Соцсети', en: 'Social media' }, aliases: ['соцсети', 'smm', 'social media', 'инстаграм', 'instagram'] },
  { id: 'pr-comms', group: 'growth', label: { ru: 'PR и коммуникации', en: 'PR / communications' }, aliases: ['pr', 'пиар', 'коммуникации', 'связи с общественностью', 'communications', 'pr-коммуникации'] },
  { id: 'community-building', group: 'growth', label: { ru: 'Строительство комьюнити', en: 'Community building' }, aliases: ['комьюнити', 'community', 'community building', 'сообщество', 'клубы'] },
  { id: 'influencer-marketing', group: 'growth', label: { ru: 'Инфлюенс-маркетинг', en: 'Influencer marketing' }, aliases: ['инфлюенсеры', 'инфлюенс', 'influencer', 'блогеры', 'influencer marketing'] },
  { id: 'crm-email', group: 'growth', label: { ru: 'CRM и email', en: 'CRM / email' }, aliases: ['crm', 'email-маркетинг', 'email маркетинг', 'рассылки', 'email', 'письма'] },

  // --- Sales & BD ------------------------------------------------------------
  {
    id: 'b2b-sales',
    group: 'sales',
    label: { ru: 'B2B-продажи', en: 'B2B sales' },
    aliases: ['b2b', 'b2b-продажи', 'корпоративные продажи', 'b2b-клиенты', 'клиенты b2b', 'продажи', 'sales', 'sales-leadership', 'b2b-clients', 'клиенты', 'аккаунт-менеджмент'],
  },
  { id: 'partnerships', group: 'sales', label: { ru: 'Партнёрства', en: 'Partnerships' }, aliases: ['партнёрства', 'партнёрство', 'partnership', 'партнёры', 'coop', 'сотрудничество', 'business development', 'bd'] },
  { id: 'distribution-channels', group: 'sales', label: { ru: 'Каналы дистрибуции', en: 'Distribution channels' }, aliases: ['дистрибуция', 'каналы продаж', 'дилеры', 'партнёрские каналы'] },
  { id: 'customer-success', group: 'sales', label: { ru: 'Customer success', en: 'Customer success' }, aliases: ['customer success', 'клиентский сервис', 'поддержка клиентов', 'customer care', 'удержание клиентов'] },
  { id: 'negotiation', group: 'sales', label: { ru: 'Переговоры', en: 'Negotiation' }, aliases: ['переговоры', 'negotiation', 'торг', 'сделки'] },
  { id: 'enterprise-sales', group: 'sales', label: { ru: 'Продажи enterprise', en: 'Enterprise sales' }, aliases: ['enterprise sales', 'enterprise', 'крупные клиенты', 'корпоративные сделки'] },

  // --- Product & design ------------------------------------------------------
  {
    id: 'product-management',
    group: 'product',
    label: { ru: 'Продукт-менеджмент', en: 'Product management' },
    aliases: ['продукт', 'product', 'продакт', 'product discovery', 'discovery', 'custdev', 'customer development', 'продуктовый менеджмент', 'roadmap'],
  },
  { id: 'ux-ui', group: 'product', label: { ru: 'UX и UI', en: 'UX / UI' }, aliases: ['ux', 'ui', 'ux/ui', 'юзабилити', 'usability', 'product-design', 'интерфейсы', 'дизайн', 'design'] },
  { id: 'design-systems', group: 'product', label: { ru: 'Дизайн-системы', en: 'Design systems' }, aliases: ['дизайн-системы', 'ui kit', 'ui-kit', 'ds', 'design systems', 'design-system'] },
  { id: 'user-research', group: 'product', label: { ru: 'Исследования пользователей', en: 'User research' }, aliases: ['исследования пользователей', 'ux research', 'ux-research', 'customer research', 'юзер-ресёрч', 'интервью'] },
  { id: 'prototyping', group: 'product', label: { ru: 'Прототипирование', en: 'Prototyping' }, aliases: ['прототипы', 'prototyping', 'прототипирование', 'mvp', 'мвп'] },
  { id: 'accessibility', group: 'product', label: { ru: 'Доступность', en: 'Accessibility' }, aliases: ['доступность', 'a11y', 'accessibility', 'инклюзивность', 'инклюзия'] },

  // --- Finance & investment --------------------------------------------------
  { id: 'personal-finance', group: 'finance', label: { ru: 'Личные финансы', en: 'Personal finance' }, aliases: ['личные финансы', 'personal finance', 'сбережения'] },
  {
    id: 'corporate-finance',
    group: 'finance',
    label: { ru: 'Корпоративные финансы', en: 'Corporate finance' },
    aliases: ['корпоративные финансы', 'cfo', 'финансовое моделирование', 'unit economics', 'finance', 'финансы', 'юнит-экономика', 'бюджетирование'],
  },
  { id: 'angel-investing', group: 'finance', label: { ru: 'Ангельские инвестиции', en: 'Angel investing' }, aliases: ['ангелы', 'ангельские инвестиции', 'angel', 'бизнес-ангел', 'angel investing', 'ангел-инвестор'] },
  { id: 'fintech', group: 'finance', label: { ru: 'Финтех', en: 'Fintech' }, aliases: ['финтех', 'fintech', 'платежи', 'payments', 'банки'] },
  { id: 'insurance', group: 'finance', label: { ru: 'Страхование', en: 'Insurance' }, aliases: ['страхование', 'insurance', 'insurtech', 'страховой бизнес'] },
  { id: 'taxes-legal', group: 'finance', label: { ru: 'Налоги и учёт', en: 'Taxes / accounting' }, aliases: ['налоги', 'налогообложение', 'taxes', 'бухгалтерия', 'accounting', 'налоговое право'] },
  { id: 'real-estate-investing', group: 'finance', label: { ru: 'Инвестиции в недвижимость', en: 'Real-estate investing' }, aliases: ['недвижимость', 'real estate', 'инвестиции в недвижимость', 'аренда', 'рента'] },

  // --- People & leadership ---------------------------------------------------
  { id: 'hiring', group: 'people', label: { ru: 'Найм', en: 'Hiring' }, aliases: ['найм', 'hiring', 'recruitment', 'рекрутинг', 'подбор', 'hr-hiring', 'подбор персонала', 'вакансии'] },
  { id: 'team-building', group: 'people', label: { ru: 'Построение команды', en: 'Team building' }, aliases: ['команда', 'team building', 'тимбилдинг', 'построение команды', 'operations', 'ops', 'process-design', 'процессы', 'операционка'] },
  { id: 'leadership', group: 'people', label: { ru: 'Лидерство', en: 'Leadership' }, aliases: ['лидерство', 'leadership', 'менеджмент', 'управление', 'управление командой'] },
  { id: 'remote-work', group: 'people', label: { ru: 'Удалённая работа', en: 'Remote work' }, aliases: ['удалёнка', 'удаленная работа', 'remote', 'remote work', 'распределённые команды', 'гибрид'] },
  { id: 'hr-culture', group: 'people', label: { ru: 'HR и культура', en: 'HR / culture' }, aliases: ['hr', 'hr-culture', 'культура', 'people ops', 'корпоративная культура', 'hr-бренд'] },
  { id: 'coaching', group: 'people', label: { ru: 'Коучинг', en: 'Coaching' }, aliases: ['коучинг', 'coaching', 'коуч'] },

  // --- Health & wellness -----------------------------------------------------
  { id: 'fitness', group: 'health', label: { ru: 'Фитнес', en: 'Fitness' }, aliases: ['фитнес', 'fitness', 'спортзал', 'тренировки', 'gym'] },
  { id: 'nutrition', group: 'health', label: { ru: 'Питание', en: 'Nutrition' }, aliases: ['питание', 'nutrition', 'нутрициология', 'диеты', 'здоровое питание'] },
  { id: 'mental-health', group: 'health', label: { ru: 'Ментальное здоровье', en: 'Mental health' }, aliases: ['ментальное здоровье', 'психология', 'mental health', 'therapy', 'психотерапия', 'осознанность'] },
  { id: 'longevity', group: 'health', label: { ru: 'Долголетие', en: 'Longevity' }, aliases: ['долголетие', 'longevity', 'biohacking', 'биохакерство', 'профилактика здоровья'] },
  { id: 'healthtech', group: 'health', label: { ru: 'Хелстех', en: 'Healthtech' }, aliases: ['хелстех', 'healthtech', 'medtech', 'медицина', 'digital health', 'медтех'] },
  { id: 'wellness', group: 'health', label: { ru: 'Wellness', en: 'Wellness' }, aliases: ['wellbeing', 'велнес', 'wellness', 'здоровье', 'beauty-wellness', 'спа', 'восстановление'] },

  // --- Beauty & fashion ------------------------------------------------------
  { id: 'beauty-industry', group: 'beauty', label: { ru: 'Бьюти-индустрия', en: 'Beauty industry' }, aliases: ['бьюти', 'beauty', 'красота', 'индустрия красоты', 'beauty industry', 'бьюти-индустрия'] },
  { id: 'skincare', group: 'beauty', label: { ru: 'Уход за кожей', en: 'Skincare' }, aliases: ['уход за кожей', 'skincare', 'косметика для кожи', 'уход'] },
  { id: 'fashion', group: 'beauty', label: { ru: 'Мода', en: 'Fashion' }, aliases: ['мода', 'fashion', 'одежда', 'стиль', 'apparel'] },
  { id: 'cosmetics-retail', group: 'beauty', label: { ru: 'Ритейл косметики', en: 'Cosmetics retail' }, aliases: ['косметика', 'cosmetics', 'магазин косметики', 'косметический ритейл', 'парфюмерия'] },
  { id: 'salon-business', group: 'beauty', label: { ru: 'Салонный бизнес', en: 'Salon business' }, aliases: ['салон', 'салон красоты', 'salon', 'барбершоп', 'spa', 'спа-салон', 'парикмахерская'] },

  // --- Education & science ---------------------------------------------------
  { id: 'edtech', group: 'education', label: { ru: 'Эдтех', en: 'Edtech' }, aliases: ['эдтех', 'edtech', 'онлайн-образование', 'образовательные технологии', 'lms'] },
  { id: 'learning', group: 'education', label: { ru: 'Обучение', en: 'Learning' }, aliases: ['обучение', 'learning', 'курсы', 'саморазвитие', 'образование', 'повышение квалификации'] },
  { id: 'academia-research', group: 'education', label: { ru: 'Наука и исследования', en: 'Academia / research' }, aliases: ['наука', 'исследования', 'research', 'академия', 'phd', 'научные исследования'] },
  { id: 'languages', group: 'education', label: { ru: 'Языки', en: 'Languages' }, aliases: ['языки', 'languages', 'английский', 'испанский', 'испанский язык', 'изучение языков', 'language exchange'] },
  { id: 'science-tech', group: 'education', label: { ru: 'Наука и технологии', en: 'Science / tech' }, aliases: ['science', 'science-tech', 'наука и технологии', 'технологии', 'tech'] },

  // --- Sustainability & impact ----------------------------------------------
  { id: 'climate', group: 'sustainability', label: { ru: 'Климат', en: 'Climate' }, aliases: ['климат', 'climate', 'климатические технологии', 'cleantech', 'климаттех'] },
  { id: 'circular-economy', group: 'sustainability', label: { ru: 'Циклическая экономика', en: 'Circular economy' }, aliases: ['циклическая экономика', 'circular economy', 'переработка', 'recycling', 'экономика замкнутого цикла'] },
  { id: 'social-impact', group: 'sustainability', label: { ru: 'Социальный импакт', en: 'Social impact' }, aliases: ['импакт', 'социальный импакт', 'social impact', 'социальный бизнес', 'ngo', 'нко', 'благотворительность'] },
  { id: 'esg', group: 'sustainability', label: { ru: 'ESG', en: 'ESG' }, aliases: ['esg', 'устойчивое развитие', 'sustainability', 'ответственное инвестирование'] },
  { id: 'energy', group: 'sustainability', label: { ru: 'Энергетика', en: 'Energy' }, aliases: ['энергетика', 'energy', 'возобновляемая энергия', 'солнечная энергия', 'solar', 'электроэнергия'] },

  // --- Lifestyle & culture ---------------------------------------------------
  { id: 'travel', group: 'lifestyle', label: { ru: 'Путешествия', en: 'Travel' }, aliases: ['путешествия', 'travel', 'туризм', 'trips', 'кочевание'] },
  { id: 'food-restaurants', group: 'lifestyle', label: { ru: 'Еда и рестораны', en: 'Food / restaurants' }, aliases: ['еда', 'рестораны', 'food', 'foodtech', 'фудтех', 'гастрономия', 'кафе', 'кулинария'] },
  { id: 'sports', group: 'lifestyle', label: { ru: 'Спорт', en: 'Sports' }, aliases: ['спорт', 'sports', 'футбол', 'бег', 'padel', 'падел', 'теннис'] },
  { id: 'art-design', group: 'lifestyle', label: { ru: 'Искусство', en: 'Art' }, aliases: ['искусство', 'art', 'иллюстрация', 'современное искусство', 'креатив'] },
  { id: 'music', group: 'lifestyle', label: { ru: 'Музыка', en: 'Music' }, aliases: ['музыка', 'music', 'djing', 'диджеинг', 'звук'] },
  { id: 'books-media', group: 'lifestyle', label: { ru: 'Книги и медиа', en: 'Books / media' }, aliases: ['книги', 'медиа', 'books', 'media', 'подкасты', 'podcasts', 'издательства', 'журналистика'] },
  { id: 'gaming', group: 'lifestyle', label: { ru: 'Гейминг', en: 'Gaming' }, aliases: ['игры', 'gaming', 'gamedev', 'esports', 'киберспорт', 'видеоигры'] },
  { id: 'photography', group: 'lifestyle', label: { ru: 'Фотография и видео', en: 'Photography / video' }, aliases: ['фотография', 'photography', 'видео', 'video', 'съёмка', 'видеопродакшн'] },

  // --- Local & community -----------------------------------------------------
  { id: 'barcelona-local', group: 'local', label: { ru: 'Барселона', en: 'Barcelona local' }, aliases: ['барселона', 'barcelona', 'каталония', 'каталуния'] },
  { id: 'spain-business', group: 'local', label: { ru: 'Бизнес в Испании', en: 'Spain business' }, aliases: ['испания', 'spain', 'бизнес в испании', 'испанский рынок'] },
  { id: 'expat-life', group: 'local', label: { ru: 'Жизнь экспатом', en: 'Expat life' }, aliases: ['экспаты', 'expat', 'релокация', 'relocation', 'переезд', 'жизнь за рубежом'] },
  { id: 'local-community', group: 'local', label: { ru: 'Локальное комьюнити', en: 'Local community' }, aliases: ['локальное комьюнити', 'местное сообщество', 'local community', 'нетворкинг', 'networking', 'peer-network', 'митапы', 'meetups'] },
  { id: 'latam-connect', group: 'local', label: { ru: 'Латинская Америка', en: 'LatAm connect' }, aliases: ['латинская америка', 'latam', 'латам', 'мексика', 'бразилия'] },

  // --- Industry ties ---------------------------------------------------------
  { id: 'retail-ecommerce', group: 'industry-ties', label: { ru: 'Ритейл и e-commerce', en: 'Retail / e-commerce' }, aliases: ['ритейл', 'retail', 'ecommerce', 'e-commerce', 'интернет-магазин', 'онлайн-продажи', 'ecom'] },
  { id: 'logistics', group: 'industry-ties', label: { ru: 'Логистика', en: 'Logistics' }, aliases: ['логистика', 'logistics', 'доставка', 'supply chain', 'цепочки поставок', 'склад'] },
  { id: 'manufacturing', group: 'industry-ties', label: { ru: 'Производство', en: 'Manufacturing' }, aliases: ['производство', 'manufacturing', 'завод', 'фабрика', 'промышленность'] },
  { id: 'public-sector', group: 'industry-ties', label: { ru: 'Госсектор', en: 'Public sector' }, aliases: ['госсектор', 'государство', 'public sector', 'government', 'госуслуги', 'муниципалитеты'] },
  { id: 'legal-services', group: 'industry-ties', label: { ru: 'Юридические услуги', en: 'Legal services' }, aliases: ['юридические услуги', 'юристы', 'legal', 'legal-services', 'право', 'contracts', 'договоры'] },
  { id: 'construction', group: 'industry-ties', label: { ru: 'Строительство', en: 'Construction' }, aliases: ['строительство', 'construction', 'стройка', 'девелопмент', 'ремонт'] },
  { id: 'tourism-horeca', group: 'industry-ties', label: { ru: 'Туризм и HoReCa', en: 'Tourism / HoReCa' }, aliases: ['horeca', 'отели', 'гостиницы', 'ресторанный бизнес', 'гостеприимство', 'tourism'] },
];

const INTEREST_BY_ID = new Map<string, InterestDef>(INTERESTS.map((i) => [i.id, i]));
const INTEREST_ORDER = new Map<string, number>(INTERESTS.map((i, idx) => [i.id, idx]));

export const INTEREST_IDS: readonly string[] = INTERESTS.map((i) => i.id);

/** alias → interest id. First declaration wins; a unit test asserts that no
 * alias string is declared by two different interests. */
const INTEREST_ALIAS_INDEX = new Map<string, string>();
for (const interest of INTERESTS) {
  for (const alias of interest.aliases) {
    const key = normalizeRaw(alias);
    if (key && !INTEREST_ALIAS_INDEX.has(key)) INTEREST_ALIAS_INDEX.set(key, interest.id);
  }
}

/** All declared alias strings (for the collision test and the migration report). */
export function declaredInterestAliases(): readonly string[] {
  return INTERESTS.flatMap((i) => i.aliases.map((a) => normalizeRaw(a)).filter(Boolean));
}

export function interestById(id: string): InterestDef | null {
  return INTEREST_BY_ID.get(id) ?? null;
}

export function interestLabel(id: string, locale: Locale): string | null {
  const interest = INTEREST_BY_ID.get(id);
  return interest ? interest.label[locale] : null;
}

export function interestOrder(id: string): number {
  return INTEREST_ORDER.get(id) ?? Number.MAX_SAFE_INTEGER;
}

export function isInterestId(id: unknown): id is string {
  return typeof id === 'string' && INTEREST_BY_ID.has(id);
}

// ---------------------------------------------------------------------------
// Intent aliases (legacy tags → intent ids) — used by the data migration
// ---------------------------------------------------------------------------

export interface IntentAliasDef {
  readonly alias: string;
  readonly intent: string;
}

export const INTENT_ALIASES: readonly IntentAliasDef[] = [
  { alias: 'mentoring', intent: 'mentoring' },
  { alias: 'mentor', intent: 'seeking-mentor' },
  { alias: 'наставничество', intent: 'seeking-mentor' },
  { alias: 'advisory', intent: 'advising' },
  { alias: 'экспертный совет', intent: 'seeking-expertise' },
  { alias: 'консалтинг', intent: 'advising' },
  { alias: 'pilot-users', intent: 'seeking-pilot-users' },
  { alias: 'pilot users', intent: 'seeking-pilot-users' },
  { alias: 'pilot', intent: 'seeking-pilot-users' },
  { alias: 'пилоты', intent: 'seeking-pilot-users' },
  { alias: 'early adopters', intent: 'seeking-pilot-users' },
  { alias: 'пилотные пользователи', intent: 'seeking-pilot-users' },
  { alias: 'feedback', intent: 'seeking-feedback' },
  { alias: 'фидбек', intent: 'seeking-feedback' },
  { alias: 'обратная связь', intent: 'seeking-feedback' },
  { alias: 'distribution', intent: 'seeking-distribution' },
  { alias: 'venue', intent: 'offering-venue' },
  { alias: 'площадка', intent: 'offering-venue' },
  { alias: 'клиенты', intent: 'seeking-clients' },
  { alias: 'инвестиции', intent: 'seeking-investment' },
  { alias: 'cofounder', intent: 'seeking-cofounder' },
  { alias: 'co-founder', intent: 'seeking-cofounder' },
  { alias: 'со-фаундер', intent: 'seeking-cofounder' },
  { alias: 'community host', intent: 'community-host' },
  { alias: 'hiring', intent: 'hiring' },
];

const INTENT_ALIAS_INDEX = new Map<string, string>();
for (const { alias, intent } of INTENT_ALIASES) {
  const key = normalizeRaw(alias);
  if (key && !INTENT_ALIAS_INDEX.has(key) && isIntentId(intent)) INTENT_ALIAS_INDEX.set(key, intent);
}

/** lc + trim + collapse inner whitespace + strip NBSP/zero-width noise. */
export function normalizeRaw(value: string): string {
  return value
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Maps a raw interest string (catalogue id, alias, RU/EN spelling) to the
 * canonical interest id, or null when it is not in the catalogue.
 */
export function normalizeInterest(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = normalizeRaw(raw);
  if (!key) return null;
  if (INTEREST_BY_ID.has(key)) return key;
  return INTEREST_ALIAS_INDEX.get(key) ?? null;
}

/**
 * Maps a raw tag to an intent id for the given column kind, flipping a
 * wrong-side id/alias to its complement. Lenient by design: used when reading
 * legacy/raw rows and by the tag→v3 data migration. API input validation uses
 * `strictIntentForKind` instead so a need id can never silently become an offer.
 */
export function normalizeIntentTag(raw: unknown, kind: 'need' | 'offer'): string | null {
  if (typeof raw !== 'string') return null;
  const key = normalizeRaw(raw);
  if (!key) return null;
  if (isIntentId(key)) return intentKind(key) === kind ? key : complementOf(key);
  const mapped = INTENT_ALIAS_INDEX.get(key);
  if (!mapped) return null;
  return intentKind(mapped) === kind ? mapped : complementOf(mapped);
}

/** Strict resolver for API input: only ids/aliases belonging to `kind`. */
export function strictIntentForKind(raw: unknown, kind: 'need' | 'offer'): string | null {
  if (typeof raw !== 'string') return null;
  const key = normalizeRaw(raw);
  if (!key) return null;
  if (isIntentId(key)) return intentKind(key) === kind ? key : null;
  const mapped = INTENT_ALIAS_INDEX.get(key);
  if (!mapped) return null;
  return intentKind(mapped) === kind ? mapped : null;
}

/** Trims/lowercases a free-form keyword; returns null when empty. */
export function normalizeKeyword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = normalizeRaw(raw);
  if (!key) return null;
  return key.length > MAX_KEYWORD_LENGTH ? key.slice(0, MAX_KEYWORD_LENGTH).trim() : key;
}

// ---------------------------------------------------------------------------
// Validation (unknown id → error with a "did you mean" hint)
// ---------------------------------------------------------------------------

/** Deterministic nearest candidate: shared 3-char prefix, then substring. */
function suggest(raw: string, candidates: readonly string[]): string | null {
  const key = normalizeRaw(raw);
  if (!key) return null;
  const prefix = candidates.filter((c) => c.startsWith(key.slice(0, 3)));
  if (prefix.length === 1) return prefix[0]!;
  const contains = candidates.filter((c) => c.includes(key) || key.includes(c));
  if (contains.length === 1) return contains[0]!;
  if (prefix.length > 0) return prefix[0]!;
  return null;
}

function unknownId(kind: string, raw: unknown, candidates: readonly string[], hint?: string): Validation<never> {
  const shown = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const suggestion = typeof raw === 'string' ? suggest(raw, candidates) : null;
  const tail = suggestion ? ` Did you mean "${suggestion}"?` : ` See ${hint ?? 'GET /api/taxonomy'} for the catalogue.`;
  return {
    ok: false,
    code: `invalid_${kind}`,
    message: `Unknown ${kind} "${shown}".${tail}`,
  };
}

/** Catalogue ids, deduped, capped; unknown ids are an error. */
function normalizeIdList(
  raw: unknown,
  max: number,
  normalizer: (value: unknown) => string | null,
  catalogue: readonly string[],
  kind: string,
): Validation<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: `invalid_${kind}`, message: `${kind} must be an array of catalogue ids (max ${max})` };
  }
  const out: string[] = [];
  for (const item of raw) {
    const id = normalizer(item);
    if (!id || !catalogue.includes(id)) return unknownId(kind, item, catalogue);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > max) {
    return { ok: false, code: `invalid_${kind}`, message: `at most ${max} ${kind} values are allowed (got ${out.length})` };
  }
  return { ok: true, value: out };
}

export function validateNeedIntents(raw: unknown): Validation<string[]> {
  return normalizeIdList(raw, MAX_NEED_INTENTS, (v) => strictIntentForKind(v, 'need'), NEED_INTENT_IDS, 'need_intents');
}

export function validateOfferIntents(raw: unknown): Validation<string[]> {
  return normalizeIdList(raw, MAX_OFFER_INTENTS, (v) => strictIntentForKind(v, 'offer'), OFFER_INTENT_IDS, 'offer_intents');
}

export function validateInterests(raw: unknown): Validation<string[]> {
  return normalizeIdList(raw, MAX_INTERESTS, normalizeInterest, INTEREST_IDS, 'interests');
}

export function validateKeywords(raw: unknown): Validation<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'invalid_keywords', message: `keywords must be an array of strings (max ${MAX_KEYWORDS})` };
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, code: 'invalid_keywords', message: 'keywords must be an array of strings' };
    }
    const key = normalizeRaw(item);
    if (!key) continue;
    if (key.length > MAX_KEYWORD_LENGTH) {
      return {
        ok: false,
        code: 'invalid_keywords',
        message: `each keyword must be at most ${MAX_KEYWORD_LENGTH} characters`,
      };
    }
    if (!out.includes(key)) out.push(key);
  }
  if (out.length > MAX_KEYWORDS) {
    return { ok: false, code: 'invalid_keywords', message: `at most ${MAX_KEYWORDS} keywords are allowed (got ${out.length})` };
  }
  return { ok: true, value: out };
}

export function validateJobFunction(raw: unknown): Validation<string | null> {
  return validateFacet(raw, JOB_FUNCTIONS, 'job_function');
}

export function validateIndustry(raw: unknown): Validation<string | null> {
  return validateFacet(raw, INDUSTRIES, 'industry');
}

function validateFacet(raw: unknown, catalogue: readonly FacetDef[], kind: string): Validation<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, code: `invalid_${kind}`, message: `${kind} must be a catalogue id or null` };
  }
  const key = normalizeRaw(raw);
  if (!key) return { ok: true, value: null };
  if (key === PREFER_NOT_TO_SAY) return { ok: true, value: null };
  const ids = catalogue.map((c) => c.id);
  if (!ids.includes(key)) return unknownId(kind, raw, ids);
  return { ok: true, value: key };
}

export function facetLabel(id: string | null, catalogue: readonly FacetDef[], locale: Locale): string | null {
  if (!id) return null;
  return catalogue.find((c) => c.id === id)?.label[locale] ?? null;
}

export function isJobFunctionId(id: unknown): id is string {
  return typeof id === 'string' && JOB_FUNCTIONS.some((f) => f.id === id);
}

export function isIndustryId(id: unknown): id is string {
  return typeof id === 'string' && INDUSTRIES.some((i) => i.id === id);
}

// ---------------------------------------------------------------------------
// Public API payload (GET /api/taxonomy)
// ---------------------------------------------------------------------------

/** Catalogue with RU+EN labels for both locales at once — the endpoint stays
 * `public, max-age=3600` cacheable because the payload never varies by locale. */
export function taxonomyPayload(): Record<string, unknown> {
  return {
    version: 'v3',
    limits: {
      need_intents: MAX_NEED_INTENTS,
      offer_intents: MAX_OFFER_INTENTS,
      interests: MAX_INTERESTS,
      keywords: MAX_KEYWORDS,
      keyword_length: MAX_KEYWORD_LENGTH,
    },
    intents: INTENTS.map((pair) => ({
      id: pair.id,
      need: { id: pair.need.id, label: pair.need.label },
      offer: { id: pair.offer.id, label: pair.offer.label },
    })),
    interests: INTERESTS.map((i) => ({ id: i.id, group: i.group, label: i.label })),
    interest_groups: INTEREST_GROUPS.map((g) => ({ id: g.id, label: g.label })),
    functions: JOB_FUNCTIONS.map((f) => ({ id: f.id, label: f.label })),
    industries: INDUSTRIES.map((i) => ({ id: i.id, label: i.label })),
    prefer_not_to_say: PREFER_NOT_TO_SAY,
  };
}

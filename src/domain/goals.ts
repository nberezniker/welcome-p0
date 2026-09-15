/**
 * Profile goals — the "why am I here" catalogue of matching v4
 * (`docs-internal/product/SOCIAL_INTEROP_AND_MATCHING.md` §B2).
 *
 * A goal is the user's own intent ("find a mentor", "enter the EU market"), and
 * it is PRIVATE: it is never published, never shown to another participant, and
 * never leaves the server except to its owner. It exists for one purpose — to
 * make that owner's recommendations *useful* (goalAlignment, §B1) instead of
 * merely similar.
 *
 * Every goal carries a PATTERN: the intent ids a candidate can carry and the
 * interest ids a candidate can share that would actually advance the goal. The
 * pattern is data, not code, so a new goal is one row — and the scorer
 * (src/domain/networking-score.ts) stays a formula.
 *
 * Label shape: `{ ru, en, es }` in full. The older taxonomy catalogue carries
 * only ru/en (es falls back to en, documented in the pass-B report); a new
 * catalogue has no excuse for that, and the connections/goals UI is localized
 * in all three languages.
 *
 * Priority = array order (design §B2: «≤3, порядок = приоритет»). The validator
 * deduplicates WITHOUT sorting, so the user's first pick stays first.
 */

export const MAX_GOALS = 3;

export type GoalId =
  | 'learn-skill'
  | 'find-mentor'
  | 'become-mentor'
  | 'find-cofounder'
  | 'hire'
  | 'get-hired'
  | 'find-clients'
  | 'get-more-clients'
  | 'enter-market'
  | 'fundraise'
  | 'invest'
  | 'find-partners'
  | 'find-community'
  | 'get-feedback'
  | 'give-feedback'
  | 'grow-network';

export interface GoalLabels {
  ru: string;
  en: string;
  es: string;
}

/**
 * What a candidate's profile must show for the goal to be advanced:
 *
 *   `candidateOffers` — candidate offer_intents that GIVE me what the goal needs
 *                       (a mentor for find-mentor, an investor for fundraise);
 *   `candidateNeeds`  — candidate need_intents that LET me give what the goal is
 *                       about (someone seeking a mentor for become-mentor);
 *   `interests`       — interest ids whose overlap signals a relevant person
 *                       (fundraising/VC for fundraise, local B2B for enter-market).
 *
 * A goal with no pattern at all (`grow-network`) is `broad`: it is served by
 * anyone with a filled profile, and the scorer gives it a neutral value instead
 * of a zero.
 */
export interface GoalPattern {
  readonly candidateOffers: readonly string[];
  readonly candidateNeeds: readonly string[];
  readonly interests: readonly string[];
  readonly broad?: boolean;
}

export interface GoalDef {
  readonly id: GoalId;
  readonly label: GoalLabels;
  readonly pattern: GoalPattern;
}

export const GOALS: readonly GoalDef[] = Object.freeze([
  {
    id: 'learn-skill',
    label: { ru: 'Освоить навык', en: 'Learn a skill', es: 'Aprender una habilidad' },
    pattern: {
      candidateOffers: ['mentoring', 'advising', 'open-to-project', 'pilot-ready'],
      candidateNeeds: [],
      interests: [],
    },
  },
  {
    id: 'find-mentor',
    label: { ru: 'Найти ментора', en: 'Find a mentor', es: 'Encontrar un mentor' },
    pattern: { candidateOffers: ['mentoring', 'advising'], candidateNeeds: [], interests: [] },
  },
  {
    id: 'become-mentor',
    label: { ru: 'Стать ментором', en: 'Become a mentor', es: 'Ser mentor' },
    pattern: {
      candidateOffers: [],
      candidateNeeds: ['seeking-mentor', 'seeking-expertise', 'seeking-feedback'],
      interests: ['coaching', 'leadership'],
    },
  },
  {
    id: 'find-cofounder',
    label: { ru: 'Найти со-фаундера', en: 'Find a co-founder', es: 'Encontrar un cofundador' },
    pattern: {
      candidateOffers: ['open-to-cofound', 'open-to-partner', 'open-to-project'],
      candidateNeeds: ['seeking-cofounder', 'seeking-cofounder-for-fund'],
      interests: ['startups', 'entrepreneurship', 'marketplaces', 'saas'],
    },
  },
  {
    id: 'hire',
    label: { ru: 'Нанять в команду', en: 'Hire', es: 'Contratar' },
    pattern: {
      candidateOffers: ['open-to-work', 'offering-services', 'supplying-services'],
      candidateNeeds: [],
      interests: ['hiring', 'team-building', 'hr-culture'],
    },
  },
  {
    id: 'get-hired',
    label: { ru: 'Найти работу', en: 'Get hired', es: 'Encontrar trabajo' },
    pattern: {
      candidateOffers: [],
      candidateNeeds: ['hiring', 'seeking-team'],
      interests: ['hiring', 'leadership', 'team-building'],
    },
  },
  {
    id: 'find-clients',
    label: { ru: 'Найти первых клиентов', en: 'Find clients', es: 'Encontrar clientes' },
    pattern: {
      candidateOffers: [],
      candidateNeeds: ['seeking-expertise', 'seeking-vendor', 'seeking-supplier', 'hiring'],
      interests: ['b2b-sales', 'small-business', 'entrepreneurship'],
    },
  },
  {
    id: 'get-more-clients',
    label: { ru: 'Больше клиентов', en: 'Get more clients', es: 'Conseguir más clientes' },
    pattern: {
      candidateOffers: [],
      candidateNeeds: ['seeking-distribution', 'seeking-community', 'seeking-pilot-users', 'seeking-partner'],
      interests: ['b2b-sales', 'distribution-channels', 'partnerships'],
    },
  },
  {
    id: 'enter-market',
    label: { ru: 'Войти в новый рынок', en: 'Enter a market', es: 'Entrar en un mercado' },
    pattern: {
      candidateOffers: ['distribution-ready', 'community-host', 'open-to-partner', 'advising'],
      candidateNeeds: [],
      interests: [
        'spain-business',
        'barcelona-local',
        'local-community',
        'expat-life',
        'retail-ecommerce',
        'tourism-horeca',
      ],
    },
  },
  {
    id: 'fundraise',
    label: { ru: 'Привлечь инвестиции', en: 'Fundraise', es: 'Levantar financiación' },
    pattern: {
      candidateOffers: ['investing', 'investing-in-funds'],
      candidateNeeds: [],
      interests: ['fundraising', 'venture-capital', 'angel-investing', 'exits-ma'],
    },
  },
  {
    id: 'invest',
    label: { ru: 'Инвестировать', en: 'Invest', es: 'Invertir' },
    pattern: {
      candidateOffers: [],
      candidateNeeds: ['seeking-investment', 'seeking-cofounder-for-fund'],
      interests: ['fundraising', 'venture-capital', 'angel-investing', 'startups'],
    },
  },
  {
    id: 'find-partners',
    label: { ru: 'Найти партнёров', en: 'Find partners', es: 'Encontrar socios' },
    pattern: {
      candidateOffers: ['open-to-partner', 'distribution-ready'],
      candidateNeeds: ['seeking-partner', 'seeking-distribution'],
      interests: ['partnerships', 'b2b-sales', 'distribution-channels'],
    },
  },
  {
    id: 'find-community',
    label: { ru: 'Найти сообщество', en: 'Find a community', es: 'Encontrar una comunidad' },
    pattern: {
      candidateOffers: ['community-host'],
      candidateNeeds: ['seeking-community'],
      interests: ['community-building', 'local-community', 'expat-life', 'barcelona-local'],
    },
  },
  {
    id: 'get-feedback',
    label: { ru: 'Получить фидбек', en: 'Get feedback', es: 'Recibir feedback' },
    pattern: {
      candidateOffers: ['offering-feedback', 'advising', 'mentoring'],
      candidateNeeds: [],
      interests: [],
    },
  },
  {
    id: 'give-feedback',
    label: { ru: 'Дать фидбек', en: 'Give feedback', es: 'Dar feedback' },
    pattern: {
      candidateOffers: [],
      candidateNeeds: ['seeking-feedback', 'seeking-expertise', 'seeking-mentor'],
      interests: [],
    },
  },
  {
    id: 'grow-network',
    label: { ru: 'Расширить круг', en: 'Grow my network', es: 'Ampliar mi red' },
    pattern: { candidateOffers: [], candidateNeeds: [], interests: [], broad: true },
  },
] satisfies readonly GoalDef[]);

export const GOAL_IDS: readonly GoalId[] = Object.freeze(GOALS.map((g) => g.id));

const BY_ID = new Map<GoalId, GoalDef>(GOALS.map((g) => [g.id, g]));

export function isGoalId(value: unknown): value is GoalId {
  return typeof value === 'string' && BY_ID.has(value as GoalId);
}

export function goalById(id: string): GoalDef | null {
  return BY_ID.get(id as GoalId) ?? null;
}

export function goalLabel(id: string, locale: keyof GoalLabels): string | null {
  const goal = goalById(id);
  return goal ? goal.label[locale] : null;
}

export interface GoalValidationOk {
  ok: true;
  /** Catalogue ids, deduplicated, in the user's own priority order. */
  value: GoalId[];
}
export interface GoalValidationError {
  ok: false;
  code: string;
  message: string;
}

/**
 * Validates the `goals` field of a profile write.
 *
 * Rules (design §B2):
 *   - a catalogue id only — an unknown id is an error, never a silent drop;
 *   - at most `MAX_GOALS`;
 *   - duplicates collapse to their FIRST position, because the array order is
 *     the priority and re-picking a goal must not promote it.
 * Absent/`null` means "no goals" (and clears a previously stored list), which
 * keeps the pre-011 clients and rows valid.
 */
export function validateGoals(raw: unknown): GoalValidationOk | GoalValidationError {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: 'invalid_goals',
      message: `goals must be an array of catalogue ids (max ${MAX_GOALS})`,
    };
  }
  const out: GoalId[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !isGoalId(item)) {
      const shown = typeof item === 'string' ? item : JSON.stringify(item);
      return {
        ok: false,
        code: 'invalid_goals',
        message: `Unknown goal "${shown}". See GET /api/taxonomy for the catalogue.`,
      };
    }
    if (!out.includes(item)) out.push(item);
  }
  if (out.length > MAX_GOALS) {
    return {
      ok: false,
      code: 'invalid_goals',
      message: `at most ${MAX_GOALS} goals are allowed (got ${out.length})`,
    };
  }
  return { ok: true, value: out };
}

/** Catalogue for pickers and GET /api/taxonomy (ids + labels, no patterns). */
export function goalsPayload(): { id: GoalId; label: GoalLabels }[] {
  return GOALS.map((goal) => ({ id: goal.id, label: { ...goal.label } }));
}

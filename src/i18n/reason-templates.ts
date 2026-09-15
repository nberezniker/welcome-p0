import type { ReasonV4Templates } from '../domain/reasons-v4';
import { es } from './es';
import { en } from './en';
import { DEFAULT_LOCALE, type Locale } from './locale';
import { ru } from './ru';

/**
 * Server-side (non-request) reason templates.
 *
 * WHY this exists next to src/i18n/index.ts: `t()` lives in a module that also
 * imports `next/headers` (for `getT()`), and the outbox worker is also run as a
 * plain Node process (`pnpm worker`, scripts/worker.mts) with no Next request at
 * all. An outbound message must be renderable from a background tick, so the
 * three `reason4.*` template groups are read straight from the dictionaries
 * here, with the same English fallback rule `t()` applies.
 *
 * Only the v4 usefulness templates are here: they are the ones a MESSAGE needs
 * (the digest's one-line reason). Keeping the same strings the UI uses is the
 * point — the message and the app must not drift into two vocabularies.
 */

type DictKey = keyof typeof en;

const DICTIONARIES: Record<Locale, Partial<Record<DictKey, string>>> = {
  en,
  ru: ru as Partial<Record<DictKey, string>>,
  es: es as Partial<Record<DictKey, string>>,
};

function lookup(locale: Locale, key: DictKey): string {
  return DICTIONARIES[locale][key] ?? en[key];
}

export function reasonV4Templates(locale: Locale = DEFAULT_LOCALE): ReasonV4Templates {
  return {
    useful: {
      goal_advanced: lookup(locale, 'reason4.useful.goal_advanced'),
      need_covered: lookup(locale, 'reason4.useful.need_covered'),
      mutual_needs: lookup(locale, 'reason4.useful.mutual_needs'),
      shared_interests: lookup(locale, 'reason4.useful.shared_interests'),
      complementary_functions: lookup(locale, 'reason4.useful.complementary_functions'),
      same_context: lookup(locale, 'reason4.useful.same_context'),
      peer_context: lookup(locale, 'reason4.useful.peer_context'),
    },
    growth: {
      can_teach: lookup(locale, 'reason4.growth.can_teach'),
      wants_your_help: lookup(locale, 'reason4.growth.wants_your_help'),
      outside_circle: lookup(locale, 'reason4.growth.outside_circle'),
      different_context: lookup(locale, 'reason4.growth.different_context'),
    },
  };
}

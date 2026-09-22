import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { en, type Dictionary } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { es } from '../../src/i18n/es';
import { CONTACT_KINDS, type ContactKind } from '../../src/domain/profile';

/**
 * The card's contact rows: every kind the projection can emit has a real,
 * localized label — proven here rather than trusted.
 *
 * WHY THIS TEST EXISTS. The rows used to be labelled from a map typed over
 * `LinkKind`, which is the five LINKABLE kinds and has no `phone`. `phone` was
 * therefore absent from the map, the lookup fell through to `?? t('pubcard.contacts')`,
 * and a phone number was labelled with the generic section word — "Контакты",
 * "Contacts", "Contactos" — on every card in every language. Nothing failed:
 * the string was present, translated, and rendered, so dictionary parity, axe,
 * overflow, tap-target and screenshot gates were all green with a wrong label on
 * screen. The failure mode was a MISSING KEY that looked like a working
 * fallback, so the only assertion that can catch it is one that enumerates the
 * kinds the row can render and demands a label for each of them.
 *
 * WHAT IS PINNED, and why each part is needed:
 *   1. every `CONTACT_KINDS` member has a non-empty `pubcard.contactLink.<kind>`
 *      in en AND ru AND es — a new kind (or a new locale) fails here;
 *   2. none of those labels is the generic section word, in any locale — that is
 *      the exact bug signature, and a label that equals it is a card that says
 *      "Contacts" twice;
 *   3. the card's label map covers every kind, and its type is the projection's
 *      kind union — the TYPE is what makes the next kind a compile error instead
 *      of another silent fallback, so the pin is on the declaration, not on a
 *      list of strings that would drift from it;
 *   4. the generic fallback cannot come back: `page.tsx` may not contain
 *      `?? t('pubcard.contacts')` in the row lookup.
 *
 * The source-level pins (3, 4) are the same kind of pin tests/unit/theme.test.ts
 * puts on the chip headings, and they are here for the same reason: a map that
 * is complete only because someone remembered to add an entry is not a
 * guarantee.
 */

const CARD_PAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'app',
  'p',
  '[slug]',
  'page.tsx',
);

const DICTIONARIES: readonly { locale: string; dict: Partial<Dictionary> }[] = [
  { locale: 'en', dict: en },
  { locale: 'ru', dict: ru },
  { locale: 'es', dict: es },
];

/** The dictionary key the card uses for one contact kind's row label. */
function labelKey(kind: ContactKind): keyof Dictionary {
  return `pubcard.contactLink.${kind}`;
}

test('card: every contact kind has a non-empty row label in all three languages', () => {
  for (const kind of CONTACT_KINDS) {
    const key = labelKey(kind);
    for (const { locale, dict } of DICTIONARIES) {
      const value = dict[key];
      assert.ok(
        typeof value === 'string' && value.trim().length > 0,
        `${locale} has no non-empty ${key}: the card can render a ${kind} row, so it needs a label for it or it will fall back to a generic word`,
      );
      assert.notEqual(
        value,
        dict['pubcard.contacts'],
        `${locale}: ${key} must not reuse the generic section word "${dict['pubcard.contacts']}" — that is exactly what the phone row used to do`,
      );
    }
  }
});

test('card: the row-label map is exhaustive over the projection kinds and cannot fall back', () => {
  const source = readFileSync(CARD_PAGE, 'utf8');

  // (3) The declaration itself: typed over `PublicContact['kind']` — every kind
  // the public projection can emit, `phone` included — rather than `LinkKind`,
  // which is what the intro dialog's field labels use.
  assert.ok(
    /contactLabels\s*:\s*Record<PublicContact\['kind'\]\s*,\s*string>/.test(source),
    "the card's contact labels must be declared as Record<PublicContact['kind'], string>; that type is what turns a new contact kind into a compile error instead of a silent fallback to the generic section word",
  );

  for (const kind of CONTACT_KINDS) {
    assert.ok(
      source.includes(`t('${labelKey(kind)}')`),
      `page.tsx never reads ${labelKey(kind)}: a contact kind the projection can emit must be mapped to its own label, not left to a fallback`,
    );
  }

  // (4) The precise shape of the old bug: a lookup that could miss and then say
  // "Contacts". Absence of the fallback is what makes the map's completeness
  // load-bearing.
  assert.ok(
    !/\?\?\s*t\('pubcard\.contacts'\)/.test(source),
    "the contact row lookup must not fall back to t('pubcard.contacts'): a missing label has to be a test failure, not a generic word rendered on a real card",
  );
});

/**
 * The card's LANGUAGE LIST carries an accessible name, and the name is localized.
 *
 * It was the one labelled-by-nothing list left on the card: the chip groups
 * (help offered / looking for / interests) have each been named by their own
 * heading for as long as the chip groups have had headings, and the languages row
 * sits ABOVE all of
 * them with no heading to borrow — there is no room for a visible one directly
 * under the person's name. It therefore gets its name from `aria-label`, which
 * `role="list"` supports, through the same dictionary key the other locales
 * already carry.
 *
 * WHY A SOURCE PIN AND NOT ONLY THE E2E ASSERTION. tests/e2e/card-contacts-qr.spec.ts
 * proves the live behaviour (the list is findable by name in all three locales).
 * This pin exists for the failure mode that e2e cannot see: the attribute being
 * dropped in a refactor while an English `aria-label="Languages"` literal — which
 * would still pass a single-locale test — takes its place. The string here has to
 * be the dictionary lookup, and the key has to exist in all three dictionaries.
 */
test('card: the language list is named through the dictionary, not a literal', () => {
  const source = readFileSync(CARD_PAGE, 'utf8');

  assert.ok(
    source.includes("aria-label={t('pubcard.languages')}"),
    "the card's language list must be named with t('pubcard.languages'); an unnamed list is announced as an unattached group of items, and a hardcoded label would ship English into a Russian card",
  );
  assert.ok(
    /<ul[^>]*aria-label=\{t\('pubcard\.languages'\)\}/.test(source),
    'the name must be on the <ul> (the list itself), not on an enclosing element: a name on the wrapper names nothing for a screen reader moving between lists',
  );

  for (const { locale, dict } of DICTIONARIES) {
    const value = dict['pubcard.languages'];
    assert.ok(
      typeof value === 'string' && value.trim().length > 0,
      `${locale} has no non-empty pubcard.languages: the card can render a language list, so it needs a name for it in every locale`,
    );
  }
  assert.notEqual(es['pubcard.languages'], en['pubcard.languages'], 'es must not fall back to the English word');
  assert.notEqual(ru['pubcard.languages'], en['pubcard.languages'], 'ru must not fall back to the English word');
});

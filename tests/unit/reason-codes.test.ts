import test from 'node:test';
import assert from 'node:assert/strict';
import { en as EN } from '../../src/i18n/en';
import { ru as RU } from '../../src/i18n/ru';
import { es as ES } from '../../src/i18n/es';
import { formatReason, formatReasons, REASON_CODES, type Reason, type ReasonTemplates } from '../../src/domain/reasons';

const labelOf = (kind: string, id: string) => `${kind}:${id}`;

/** Dictionary lookup with the "must exist" assertion baked in (ru/es are Partial). */
function key(dict: Record<string, string | undefined>, name: string): string {
  const value = dict[name];
  assert.equal(typeof value, 'string', `${name} must exist in this dictionary`);
  return value as string;
}

/** The real English templates, assembled the way a server page assembles them. */
const REAL: ReasonTemplates = {
  me: {
    intent_need_covered: EN['reason.me.intent_need_covered'],
    intent_offer_match: EN['reason.me.intent_offer_match'],
    shared_interests: EN['reason.me.shared_interests'],
    shared_function: EN['reason.me.shared_function'],
    same_industry: EN['reason.me.same_industry'],
    shared_tag: EN['reason.me.shared_tag'],
  },
  them: {
    intent_need_covered: EN['reason.them.intent_need_covered'],
    intent_offer_match: EN['reason.them.intent_offer_match'],
    shared_interests: EN['reason.them.shared_interests'],
    shared_function: EN['reason.them.shared_function'],
    same_industry: EN['reason.them.same_industry'],
    shared_tag: EN['reason.them.shared_tag'],
  },
};

test('reason codes: the vocabulary is exactly the six documented facts', () => {
  assert.deepEqual([...REASON_CODES], [
    'intent_need_covered',
    'intent_offer_match',
    'shared_interests',
    'shared_function',
    'same_industry',
    'shared_tag',
  ]);
});

test('formatReason: intent codes interpolate the resolved need goal', () => {
  const reason: Reason = { code: 'intent_need_covered', params: { need: 'seeking-cofounder', offer: 'open-to-cofound' } };
  assert.equal(
    formatReason(reason, 'me', REAL, (kind, id) => (kind === 'need' ? 'a co-founder' : id)),
    'You are looking for a co-founder — they can offer it',
  );
  // …and the same facts read from the other side with the other template.
  assert.equal(
    formatReason(reason, 'them', REAL, (kind, id) => (kind === 'need' ? 'a co-founder' : id)),
    'They are looking for a co-founder — you can offer it',
  );
});

test('formatReason: interests join in catalogue order, tags stay raw user text', () => {
  const interests: Reason = { code: 'shared_interests', params: { interests: ['ai-ml', 'startups'] } };
  assert.equal(
    formatReason(interests, 'me', REAL, (kind, id) => `${kind}=${id}`),
    'Shared interests: interest=ai-ml, interest=startups',
  );
  // Tags are user text and are escaped by React at render time, never here.
  const tag: Reason = { code: 'shared_tag', params: { tag: '<b>seed money</b>' } };
  assert.equal(formatReason(tag, 'them', REAL, labelOf), '<b>seed money</b>');
});

test('formatReason: function and industry resolve through the catalogue', () => {
  assert.equal(
    formatReason({ code: 'shared_function', params: { function: 'founder-ceo' } }, 'me', REAL, labelOf),
    'Same professional context: function:founder-ceo',
  );
  assert.equal(
    formatReason({ code: 'same_industry', params: { industry: 'ai-saas' } }, 'them', REAL, labelOf),
    'Same industry: industry:ai-saas',
  );
});

test('formatReason: a missing param or unknown code degrades instead of throwing', () => {
  // A missing param blanks the whole sentence rather than rendering a half one.
  const noParams: Reason = { code: 'intent_need_covered', params: {} };
  assert.equal(formatReason(noParams, 'me', REAL, labelOf), '');
  const unknown = { code: 'not_a_code', params: {} } as unknown as Reason;
  assert.equal(formatReason(unknown, 'me', REAL, labelOf), '');
});

test('formatReasons: drops empty renderings, keeps order', () => {
  const reasons: Reason[] = [
    { code: 'shared_tag', params: { tag: 'frontend' } },
    // an empty overlap is not a fact — the sentence must disappear
    { code: 'shared_interests', params: { interests: [] } },
    { code: 'same_industry', params: { industry: 'fintech' } },
  ];
  const lines = formatReasons(reasons, 'me', REAL, labelOf);
  assert.deepEqual(lines, ['frontend', 'Same industry: industry:fintech']);
});

test('reason templates: every code has a template in every locale, per audience', () => {
  for (const dict of [EN, RU, ES]) {
    for (const code of REASON_CODES) {
      for (const audience of ['me', 'them'] as const) {
        const name = `reason.${audience}.${code}`;
        assert.ok(key(dict as Record<string, string | undefined>, name).length > 0, `${name} must not be empty`);
      }
    }
  }
});

test('reason templates: the two audiences cannot render the same sentence by accident', () => {
  // The v1 defect was reasons_for_me === reasons_for_them. The templates differ
  // in every locale, so mirroring the viewpoint must change the sentence.
  for (const [name, dict] of [['en', EN], ['ru', RU], ['es', ES]] as const) {
    const d = dict as Record<string, string | undefined>;
    assert.notEqual(key(d, 'reason.me.intent_need_covered'), key(d, 'reason.them.intent_need_covered'), name);
    assert.notEqual(key(d, 'reason.me.intent_offer_match'), key(d, 'reason.them.intent_offer_match'), name);
  }
  // …and the mirrored pair reads as the same fact from the other side:
  // "you are looking for X — they can offer it" / "they are looking for X — you can offer it"
  assert.match(EN['reason.me.intent_need_covered'], /^You are looking for \{need\}/);
  assert.match(EN['reason.them.intent_need_covered'], /^They are looking for \{need\}/);
});

test('reason templates: localized, not English copies', () => {
  assert.notEqual(EN['reason.me.intent_need_covered'], RU['reason.me.intent_need_covered']);
  assert.notEqual(EN['reason.me.intent_need_covered'], ES['reason.me.intent_need_covered']);
  assert.equal(EN['reason.me.intent_offer_match'], 'They are looking for {need} — you can offer it');
  assert.match(key(RU as Record<string, string | undefined>, 'reason.me.intent_need_covered'), /Вы ищете \{need\}/);
  assert.match(key(ES as Record<string, string | undefined>, 'reason.me.intent_need_covered'), /Buscas \{need\}/);
});

test('formatReason: rendering reuses the same templates for all three locales', () => {
  const reason: Reason = { code: 'shared_interests', params: { interests: ['ai-ml'] } };
  for (const [locale, dict] of [['en', EN], ['ru', RU], ['es', ES]] as const) {
    const template = key(dict as Record<string, string | undefined>, 'reason.me.shared_interests');
    const templatesFor: ReasonTemplates = { me: { ...REAL.me, shared_interests: template }, them: REAL.them };
    const line = formatReason(reason, 'me', templatesFor, (kind, id) => `${locale}:${kind}:${id}`);
    assert.ok(line.includes(`${locale}:interest:ai-ml`), line);
    assert.ok(line.includes(template.split('{interests}')[0]!.trim()), line);
  }
});

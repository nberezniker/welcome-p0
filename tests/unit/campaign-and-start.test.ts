import test from 'node:test';
import assert from 'node:assert/strict';
import {
  campaignEditTransition,
  canSend,
  validateCampaignCreate,
  validateCampaignEdit,
  isCampaignPurpose,
} from '../../src/domain/campaigns';
import { extractStartToken, startsWithCommand } from '../../src/infra/telegram-handlers';

// ---------------------------------------------------------------------------
// Campaign edit → approval reset rules (AC-40) — pure domain
// ---------------------------------------------------------------------------

test('campaign edit: draft stays draft, revision increments, approval cleared', () => {
  const t = campaignEditTransition('draft', 1);
  assert.equal(t.allowed, true);
  assert.equal(t.nextState, 'draft');
  assert.equal(t.nextRevision, 2);
  assert.equal(t.nextApprovedRevision, null);
});

test('campaign edit: approved drops to draft with approval reset (AC-40)', () => {
  const t = campaignEditTransition('approved', 3);
  assert.equal(t.allowed, true);
  assert.equal(t.nextState, 'draft');
  assert.equal(t.nextRevision, 4);
  assert.equal(t.nextApprovedRevision, null);
});

test('campaign edit: running/completed/cancelled are immutable', () => {
  for (const state of ['running', 'completed', 'cancelled'] as const) {
    const t = campaignEditTransition(state, 2);
    assert.equal(t.allowed, false, `${state} must reject edits`);
    assert.equal(t.reason, 'immutable_state');
  }
});

test('canSend: requires approved with matching current revision', () => {
  assert.equal(canSend('approved', 4, 4), true);
  assert.equal(canSend('draft', 1, null), false);
  assert.equal(canSend('approved', 5, 4), false, 'stale approval (revision mismatch) must block send');
  assert.equal(canSend('approved', 4, null), false);
  assert.equal(canSend('running', 4, 4), false);
});

test('validateCampaignCreate: purpose registry is closed to the two spec values', () => {
  assert.equal(isCampaignPurpose('organizer_marketing'), true);
  assert.equal(isCampaignPurpose('service_channel'), true);
  assert.equal(isCampaignPurpose('product_marketing'), false, 'campaigns may not use product_marketing');
  assert.equal(isCampaignPurpose('newsletter'), false);
});

const EVENT = '3f2c6e40-7e1b-4f5c-9a3d-0a1b2c3d4e5f';

test('validateCampaignCreate: valid input', () => {
  const r = validateCampaignCreate({ event_id: EVENT, purpose: 'organizer_marketing', body_text: ' Join us! ' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.bodyText, 'Join us!'); // trimmed
  }
});

test('validateCampaignCreate: rejects junk', () => {
  assert.equal(validateCampaignCreate(null).ok, false);
  assert.equal(validateCampaignCreate({ purpose: 'organizer_marketing', body_text: 'x' }).ok, false);
  assert.equal(validateCampaignCreate({ event_id: EVENT, purpose: 'spam', body_text: 'x' }).ok, false);
  assert.equal(validateCampaignCreate({ event_id: 'nope', purpose: 'service_channel', body_text: 'x' }).ok, false);
  assert.equal(validateCampaignCreate({ event_id: EVENT, purpose: 'service_channel', body_text: '' }).ok, false);
  assert.equal(
    validateCampaignCreate({ event_id: EVENT, purpose: 'service_channel', body_text: 'x'.repeat(4001) }).ok,
    false,
  );
});

test('validateCampaignEdit: partial edits allowed, empty edit rejected', () => {
  assert.equal(validateCampaignEdit({ body_text: 'new body' }).ok, true);
  assert.equal(validateCampaignEdit({ purpose: 'organizer_marketing' }).ok, true);
  assert.equal(validateCampaignEdit({ audience_filter: { tag: ['a'] } }).ok, true);
  assert.equal(validateCampaignEdit({}).ok, false);
  assert.equal(validateCampaignEdit({ audience_filter: [] }).ok, false);
  assert.equal(validateCampaignEdit({ purpose: 'product_marketing' }).ok, false);
});

// ---------------------------------------------------------------------------
// /start deep-link token extraction
// ---------------------------------------------------------------------------

test('/start: link_ token extracted with full deep-link', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-';
  assert.equal(extractStartToken(`/start link_${token}`), token);
  assert.equal(extractStartToken(`  /start link_${token}  `), token);
});

test('/start: without token or with junk payload → null', () => {
  assert.equal(extractStartToken('/start'), null);
  assert.equal(extractStartToken('/start link_short'), null); // < 20 chars
  assert.equal(extractStartToken('/start some_token_that_is_long_enough_but_wrong_prefix'), null);
  assert.equal(extractStartToken(null), null);
  assert.equal(extractStartToken('hello there'), null);
});

test('startsWithCommand: case-insensitive prefix match', () => {
  assert.equal(startsWithCommand('/Stop', '/stop'), true);
  assert.equal(startsWithCommand('/stop extra args', '/stop'), true);
  assert.equal(startsWithCommand('/stopping', '/stop'), true); // P0: prefix match, typos still treated as the command
  assert.equal(startsWithCommand('/stoppage here', '/stop'), true);
});

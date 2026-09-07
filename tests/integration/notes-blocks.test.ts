import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { POST as joinRoute } from '../../src/app/api/events/[eventIdOrSlug]/join/route';
import { PATCH as membershipPatchRoute } from '../../src/app/api/me/memberships/[membershipId]/route';
import { GET as directoryRoute } from '../../src/app/api/events/[eventIdOrSlug]/directory/route';
import { GET as recommendationsRoute } from '../../src/app/api/events/[eventIdOrSlug]/recommendations/route';
import { POST as createIntroRoute } from '../../src/app/api/introductions/route';
import { PUT as putNoteRoute } from '../../src/app/api/me/notes/[otherProfileId]/route';
import { GET as getNotesRoute } from '../../src/app/api/me/notes/route';
import { POST as blocksRoute } from '../../src/app/api/blocks/route';
import { DELETE as unblockRoute } from '../../src/app/api/blocks/[targetAccountId]/route';
import { POST as reportsRoute } from '../../src/app/api/reports/route';
import { getSql, closeSql } from '../../src/lib/db';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus, accountIdFromCookie } from './helpers';

after(async () => {
  await closeSql();
});

interface User {
  cookie: string;
  accountId: string;
  profileId: string;
}

async function login(prefix: string, tags: { offers?: string[]; needs?: string[] } = {}): Promise<User> {
  const email = uniqueEmail(prefix);
  const cookie = await loginViaOtp(requestOtp, verifyOtp, email);
  const accountId = await accountIdFromCookie(cookie);
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', {
      body: { display_name: `NB ${prefix}`, languages: ['en'], offer_tags: tags.offers ?? [], need_tags: tags.needs ?? [] },
      cookie,
    }),
  );
  assertStatus(res, 200);
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`SELECT id FROM profiles WHERE account_id = ${accountId}`;
  return { cookie, accountId, profileId: rows[0]!.id };
}

async function createEvent(cookie: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: { name: 'NB Meetup', mode: 'offline', access_mode: 'public', timezone: 'UTC', ...overrides },
      cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string; slug: string } }).event;
}

async function join(user: User, idOrSlug: string): Promise<void> {
  const res = await joinRoute(makeRequest(`/api/events/${idOrSlug}/join`, { body: {}, cookie: user.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: idOrSlug }),
  });
  assertStatus(res, 200);
}

function putNote(user: User, otherProfileId: string, body: Record<string, unknown>): Promise<Response> {
  return putNoteRoute(makeRequest(`/api/me/notes/${otherProfileId}`, { method: 'PUT', body, cookie: user.cookie }), {
    params: Promise.resolve({ otherProfileId }),
  });
}

async function getNotes(user: User): Promise<Response> {
  return getNotesRoute(makeRequest('/api/me/notes', { cookie: user.cookie }));
}

test('notes: upsert own private note about a connected member; list is owner-only', async () => {
  const { cookie: org } = await login('nb1-org');
  const e = await createEvent(org);
  const a = await login('nb1-a');
  const b = await login('nb1-b');
  await join(a, e.id);
  await join(b, e.id);

  // Unconnected stranger → 403 (AC-35 semantics: notes only about your own circle).
  const stranger = await login('nb1-stranger');
  const strangerRes = await putNote(a, stranger.profileId, { note_text: 'x' });
  assertStatus(strangerRes, 403);

  const first = await putNote(a, b.profileId, { note_text: 'Met at the venue; intro to designer', next_step: 'Send portfolio' });
  assertStatus(first, 200);
  const firstBody = (await first.json()) as { note: { note_text: string; next_step: string | null; next_step_status: string } };
  assert.equal(firstBody.note.note_text, 'Met at the venue; intro to designer');
  assert.equal(firstBody.note.next_step_status, 'none');

  // Upsert: same key updates, no duplicate.
  const second = await putNote(a, b.profileId, { note_text: 'Updated note', next_step: 'Send portfolio', next_step_status: 'proposed' });
  assertStatus(second, 200);
  const sql = getSql();
  const count = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM connection_notes WHERE owner_account_id = ${a.accountId}`;
  assert.equal(count[0]?.count, 1);

  // GET returns only the owner's own notes; b sees nothing of a's.
  const list = await getNotes(a);
  const listBody = (await list.json()) as { notes: Array<{ other_profile_id: string; note_text: string; next_step_status: string }> };
  assert.equal(listBody.notes.length, 1);
  assert.equal(listBody.notes[0]?.other_profile_id, b.profileId);
  assert.equal(listBody.notes[0]?.note_text, 'Updated note');
  assert.equal(listBody.notes[0]?.next_step_status, 'proposed');

  const bList = await getNotes(b);
  assert.deepEqual(((await bList.json()) as { notes: unknown[] }).notes, []);

  // Anonymous 401; unknown other profile 404; invalid status 400.
  assertStatus(await getNotesRoute(makeRequest('/api/me/notes')), 401);
  assertStatus(await putNote(a, 'd0000000-0000-4000-8000-000000000009', { note_text: 'x' }), 404);
  assertStatus(await putNote(a, b.profileId, { note_text: 'x', next_step_status: 'bogus' }), 400);
});

test('notes: AC-35 — organizer (not a participant) cannot attach or see participant notes', async () => {
  const org = await login('nb2-org');
  const e = await createEvent(org.cookie);
  const participant = await login('nb2-p');
  await join(participant, e.id);

  // Organizer never joined → shares NO membership with the participant.
  const participantNote = await putNote(participant, org.profileId, { note_text: 'try organizer' });
  assertStatus(participantNote, 403); // organizer is not a member → no note about them

  // The organizer account has its own (empty) notes namespace — participant notes
  // are unreachable for them by construction.
  const orgNotes = await getNotes(org);
  assert.deepEqual(((await orgNotes.json()) as { notes: unknown[] }).notes, []);
});

test('blocks: suppress directory, recommendations and intro creation; unblock restores', async () => {
  const { cookie: org } = await login('nb3-org');
  const e = await createEvent(org);
  const a = await login('nb3-a', { offers: ['mentoring'], needs: ['frontend'] });
  const b = await login('nb3-b', { offers: ['frontend'], needs: ['mentoring'] });
  await join(a, e.id);
  await join(b, e.id);

  // Both opt into the directory so they are visible in directory/recommendations.
  const sql0 = getSql();
  for (const u of [a, b]) {
    const mids = await sql0<{ id: string }[]>`SELECT id FROM event_memberships WHERE profile_id = ${u.profileId} AND event_id = ${e.id}`;
    await membershipPatchRoute(
      makeRequest(`/api/me/memberships/${mids[0]!.id}`, { body: { directory_visible: true }, cookie: u.cookie }),
      { params: Promise.resolve({ membershipId: mids[0]!.id }) },
    );
  }

  const blockRes = await blocksRoute(makeRequest('/api/blocks', { body: { target_account_id: b.accountId }, cookie: a.cookie }));
  assertStatus(blockRes, 200);

  const sql = getSql();
  const inDb = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM blocks
    WHERE blocker_account_id = ${a.accountId} AND target_account_id = ${b.accountId}
  `;
  assert.equal(inDb[0]?.count, 1);

  // a's view of the directory no longer contains b.
  const dir = await directoryRoute(makeRequest(`/api/events/${e.id}/directory`, { cookie: a.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: e.id }),
  });
  const dirBody = (await dir.json()) as { members: Array<{ profile_id: string }> };
  assert.equal(dirBody.members.some((m) => m.profile_id === b.profileId), false, 'blocked member hidden from directory');

  const recs = await recommendationsRoute(makeRequest(`/api/events/${e.id}/recommendations`, { cookie: a.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: e.id }),
  });
  const recsBody = (await recs.json()) as { recommendations: Array<{ profile_id: string }> };
  assert.equal(recsBody.recommendations.some((r) => r.profile_id === b.profileId), false, 'blocked member not recommended');

  const introRes = await createIntroRoute(
    makeRequest('/api/introductions', { body: { target_profile_id: b.profileId, event_id: e.id }, cookie: a.cookie }),
  );
  assertStatus(introRes, 403); // intro impossible while blocked

  // b cannot create an intro toward a either (mutual suppression).
  const reverseIntro = await createIntroRoute(
    makeRequest('/api/introductions', { body: { target_profile_id: a.profileId, event_id: e.id }, cookie: b.cookie }),
  );
  assertStatus(reverseIntro, 403);

  // Unblock restores the pair everywhere.
  const unblock = await unblockRoute(makeRequest(`/api/blocks/${b.accountId}`, { method: 'DELETE', cookie: a.cookie }), {
    params: Promise.resolve({ targetAccountId: b.accountId }),
  });
  assertStatus(unblock, 200);

  const dir2 = await directoryRoute(makeRequest(`/api/events/${e.id}/directory`, { cookie: a.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: e.id }),
  });
  const dir2Body = (await dir2.json()) as { members: Array<{ profile_id: string }> };
  assert.equal(dir2Body.members.some((m) => m.profile_id === b.profileId), true, 'unblock restores directory visibility');
  const recs2 = await recommendationsRoute(makeRequest(`/api/events/${e.id}/recommendations`, { cookie: a.cookie }), {
    params: Promise.resolve({ eventIdOrSlug: e.id }),
  });
  const recs2Body = (await recs2.json()) as { recommendations: Array<{ profile_id: string }> };
  assert.equal(recs2Body.recommendations.some((r) => r.profile_id === b.profileId), true, 'unblock restores recommendations');

  const audits = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM audit_events
    WHERE action = 'block.created' AND actor_account_id = ${a.accountId} AND target_id = ${b.accountId}
  `;
  assert.equal(audits[0]?.count, 1);
});

test('blocks: self-block 400; unknown target 404; anonymous 401', async () => {
  const a = await login('nb4-a');
  assertStatus(await blocksRoute(makeRequest('/api/blocks', { body: { target_account_id: a.accountId }, cookie: a.cookie })), 400);
  assertStatus(await blocksRoute(makeRequest('/api/blocks', { body: { target_account_id: 'e0000000-0000-4000-8000-000000000009' }, cookie: a.cookie })), 404);
  assertStatus(await blocksRoute(makeRequest('/api/blocks', { body: { target_account_id: a.accountId } })), 401);
});

test('reports: stored with open status; invalid reason 400', async () => {
  const a = await login('nb5-a');
  const b = await login('nb5-b');

  const res = await reportsRoute(
    makeRequest('/api/reports', { body: { target_account_id: b.accountId, reason: 'spam', details: 'Bulk DMs' }, cookie: a.cookie }),
  );
  assertStatus(res, 201);

  const sql = getSql();
  const rows = await sql<{ reason: string; status: string; details: string | null }[]>`
    SELECT reason, status, details FROM reports WHERE reporter_account_id = ${a.accountId} AND target_account_id = ${b.accountId}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.reason, 'spam');
  assert.equal(rows[0]?.status, 'open');

  const bad = await reportsRoute(
    makeRequest('/api/reports', { body: { target_account_id: b.accountId, reason: 'revenge' }, cookie: a.cookie }),
  );
  assertStatus(bad, 400);
});

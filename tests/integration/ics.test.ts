import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { POST as requestOtp } from '../../src/app/api/auth/otp/request/route';
import { POST as verifyOtp } from '../../src/app/api/auth/otp/verify/route';
import { POST as createProfileRoute } from '../../src/app/api/me/profile/route';
import { POST as createEventRoute } from '../../src/app/api/organizer/events/route';
import { GET as icsRoute } from '../../src/app/api/events/[eventIdOrSlug]/ics/route';
import { closeSql } from '../../src/lib/db';
import { loginViaOtp, makeRequest, uniqueEmail, assertStatus } from './helpers';

/**
 * GET /api/events/[eventIdOrSlug]/ics — the calendar file.
 *
 * Access mirrors the event page (public), and `online_link` is the one field
 * that must never leave in a downloadable file.
 */

after(async () => {
  await closeSql();
});

async function login(prefix: string): Promise<string> {
  const cookie = await loginViaOtp(requestOtp, verifyOtp, uniqueEmail(prefix));
  const res = await createProfileRoute(
    makeRequest('/api/me/profile', { body: { display_name: `Owner ${prefix}` }, cookie }),
  );
  assertStatus(res, 200);
  return cookie;
}

async function createEvent(cookie: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; slug: string }> {
  const res = await createEventRoute(
    makeRequest('/api/organizer/events', {
      body: {
        name: 'ICS Meetup',
        mode: 'online',
        access_mode: 'public',
        timezone: 'Europe/Madrid',
        ...overrides,
      },
      cookie,
    }),
  );
  assertStatus(res, 201);
  return ((await res.json()) as { event: { id: string; slug: string } }).event;
}

async function getIcs(idOrSlug: string, cookie?: string): Promise<Response> {
  return icsRoute(makeRequest(`/api/events/${idOrSlug}/ics`, cookie ? { cookie } : undefined), {
    params: Promise.resolve({ eventIdOrSlug: idOrSlug }),
  });
}

test('ics: public download with the right headers, UTC stamps and a stable UID', async () => {
  const cookie = await login('ics-basic');
  const event = await createEvent(cookie, {
    name: 'Founders Mixer',
    description: 'Talks and drinks',
    consent_text: 'Recording is opt-in.',
    location_label: 'Carrer de Mallorca 1',
    starts_at: '2026-11-05T17:30:00Z',
    ends_at: '2026-11-05T19:30:00Z',
  });

  // Anonymous: no cookie, exactly like a crawler or a shared link.
  const res = await getIcs(event.slug);
  assertStatus(res, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/calendar; charset=utf-8$/);
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="welcome-${event.slug}.ics"`);

  const body = await res.text();
  assert.ok(body.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(body.endsWith('END:VCALENDAR\r\n'));
  assert.ok(body.includes('X-WR-TIMEZONE:Europe/Madrid'));
  assert.ok(body.includes('DTSTART:20261105T173000Z'));
  assert.ok(body.includes('DTEND:20261105T193000Z'));
  assert.ok(body.includes(`UID:welcome-event-${event.id}@`));
  assert.ok(body.includes('SUMMARY:Founders Mixer'));
  assert.ok(body.includes('LOCATION:Carrer de Mallorca 1'));
  assert.ok(body.includes('DESCRIPTION:Talks and drinks\\n\\nRecording is opt-in.'));

  // Stable identity across downloads: only DTSTAMP may differ.
  const again = await (await getIcs(event.id)).text();
  const strip = (text: string) => text.replace(/^DTSTAMP:.*$/m, '');
  assert.equal(strip(again), strip(body));

  // By id as well as by slug.
  assertStatus(await getIcs(event.id), 200);
});

test('ics: the room link never leaves in a downloadable file', async () => {
  const cookie = await login('ics-link');
  const onlineLink = 'https://meet.example/room/secret-token-42';
  const event = await createEvent(cookie, {
    name: 'Online Meetup',
    mode: 'online',
    online_link: onlineLink,
    starts_at: '2026-11-05T17:30:00Z',
  });

  const body = await (await getIcs(event.slug)).text();
  assert.equal(body.includes(onlineLink), false);
  assert.equal(body.includes('secret-token-42'), false);
  assert.equal(body.includes('meet.example'), false);
});

test('ics: an event without a schedule answers 409, not a broken file', async () => {
  const cookie = await login('ics-nodate');
  const event = await createEvent(cookie, { name: 'Undated Meetup' });
  const res = await getIcs(event.slug);
  assertStatus(res, 409);
  const body = (await res.json()) as { code: string };
  assert.equal(body.code, 'no_schedule');
});

test('ics: a missing event answers 404 for slug and id alike', async () => {
  assertStatus(await getIcs('no-such-event-slug'), 404);
  assertStatus(await getIcs('11111111-1111-1111-1111-111111111111'), 404);
});

test('ics: user text is escaped, never able to open a second VEVENT', async () => {
  const cookie = await login('ics-inject');
  const event = await createEvent(cookie, {
    name: 'Injected\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Evil',
    location_label: 'Room; 1, Floor 2',
    starts_at: '2026-11-05T17:30:00Z',
  });
  const body = await (await getIcs(event.slug)).text();
  const lines = body.split('\r\n');
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 1);
  assert.equal(lines.filter((l) => l === 'END:VEVENT').length, 1);
  assert.ok(lines.includes('LOCATION:Room\\; 1\\, Floor 2'));
});

#!/usr/bin/env node
// DEMO SEEDER: creates the live-demo event "WELCOME Demo Meetup — Product &
// Growth" for demo1@welcome.test (organizer owner) with 8 unclaimed CSV
// registrations, directory+recommendation memberships for demo1/demo2 and one
// mutual event-context introduction between them (reveal both ways).
//
// It also seeds a synthetic demo partner (Marta Ruiz, is_demo) whose membership
// tags match the REAL owner profile ("Nikita Berezniker") two-way, so the owner
// account has a genuine explainable match + intro to demo. The owner's own
// profile/membership is only READ + verified here — never written: the script
// fails loudly if that real membership is missing or not match-eligible.
//
// All seeded rows are demo data (is_demo accounts, synthetic guests under
// demo-csv-N@welcome.test, synthetic partner under marta.demo@welcome.test).
// The script prints what it created / updated / skipped and is idempotent:
// re-running upserts by event slug, (event_id, provider, external_guest_id),
// the synthetic email lookup hash / account_id and the canonical introduction
// pair — never duplicates.
//
// Safety: refuses to run against APP_ENV=production OR a non-local database
// unless --allow-production-demo is passed (staging-test only; data is_demo).
//
// Run (staging / live demo DB): node --import tsx scripts/seed-demo-event.mts --allow-production-demo
// with DATABASE_URL (or NEON_CONN_DIRECT from .env.deploy.secrets), HASH_PEPPER,
// ENCRYPTION_KEY in the environment.
import postgres from 'postgres';
import { emailLookupHash, encryptValue, generatePublicSlug } from '../src/lib/crypto.ts';
import { isProduction } from '../src/lib/env.ts';
import { canonicalPair, eventContextKey } from '../src/domain/introductions.ts';
import { scorePair } from '../src/domain/matching.ts';
import { recommendForEvent } from '../src/domain/recommendations.ts';

const ALLOW_FLAG = '--allow-production-demo';
const allowProductionDemo = process.argv.includes(ALLOW_FLAG);

const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.NEON_CONN_DIRECT || // .env.deploy.secrets (staging/live) — never printed here
  'postgres://localhost:5432/welcome_dev';

// Refuse remote/live databases and production unless explicitly allowed. The
// demo rows are synthetic (is_demo) but the guard must stay explicit.
const isRemoteDb = !/localhost|127\.0\.0\.1|::1/.test(databaseUrl.replace(/^.*@/, ''));
if ((isProduction() || isRemoteDb) && !allowProductionDemo) {
  console.error(
    `REFUSED: seed-demo-event targets a ${isProduction() ? 'production APP_ENV' : 'non-local database'} ` +
      `and the data is demo-only. Re-run with ${ALLOW_FLAG} if this is an intentional staging test.`,
  );
  process.exit(1);
}

const pepper = process.env.HASH_PEPPER;
const encKey = process.env.ENCRYPTION_KEY;
if (!pepper || !encKey) {
  console.error('HASH_PEPPER and ENCRYPTION_KEY are required (registration hashes + encrypted emails)');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

// ---------------------------------------------------------------------------
// Constants: the demo organizer, event, join code and tag geometry
// ---------------------------------------------------------------------------
const ORGANIZER_NAME = 'WELCOME Demo';
const EVENT_SLUG = 'welcome-demo-meetup';
const EVENT_NAME = 'WELCOME Demo Meetup — Product & Growth';
const EVENT_TZ = 'Europe/Madrid';
const JOIN_CODE = 'WELCOME24';
const EVENT_DESCRIPTION =
  'Открытая демо-встреча WELCOME: как продуктовые команды и основатели знакомятся на событиях — ' +
  'директория участников, взаимные рекомендации и приватные знакомства. Все участники — синтетические демо-данные.';
const CONSENT_TEXT =
  'Участвуя в демо-событии, вы соглашаетесь, что ваши имя, компания и теги видны другим участникам директории, ' +
  'а контакты открываются только при взаимном согласии.';

const EVENT_OFFERS = ['product design', 'ux'];
const EVENT_NEEDS = ['pilot users', 'feedback'];

// 8 synthetic guests; emails live only as HMAC lookup hashes + AES-256 ciphertext.
const GUESTS = [
  { n: 'Laura Vidal', role: 'Head of Product', company: 'Nexo Studio', tags: ['product design', 'ux'] },
  { n: 'Marc Puig', role: 'Founder', company: 'Loopmetrics', tags: ['pilot users', 'feedback'] },
  { n: 'Sofía Ibáñez', role: 'Growth Lead', company: 'Kite Labs', tags: ['growth', 'pilot users'] },
  { n: 'Jordi Roca', role: 'UX Researcher', company: 'Freelance', tags: ['ux', 'feedback'] },
  { n: 'Elena Marín', role: 'Product Manager', company: 'Brightpath', tags: ['product design', 'growth'] },
  { n: 'Pau Serra', role: 'CTO', company: 'Stackbeam', tags: ['pilot users', 'b2b'] },
  { n: 'Nuria Bosch', role: 'Customer Success', company: 'Loopmetrics', tags: ['feedback', 'pilot users'] },
  { n: 'Óscar Feliu', role: 'Design Director', company: 'Forma Digital', tags: ['ux', 'product design'] },
];

// ---------------------------------------------------------------------------
// Synthetic demo partner for the REAL owner account
// ---------------------------------------------------------------------------
// Marta is a full demo member (account + profile + contacts + membership) so
// the owner sees an explainable two-way match and a mutual introduction in the
// event. Her membership tag override is the matching surface:
//   Marta offers {b2b-clients, ai-pilots}          -> owner needs, 2 of 4 covered
//   Marta needs  {ai-transformation, automation}   -> owner offers, 2 of 2 covered
// Frozen formula (src/domain/matching.ts):
//   d(owner→partner) = 2/4 = 0.5, d(partner→owner) = 2/2 = 1.0
//   score = round(100 * (0.6*min(0.5,1.0) + 0.4*(0.5+1.0)/2)) = 60
const PARTNER_EMAIL = 'marta.demo@welcome.test'; // stable synthetic email = idempotency key
const PARTNER = {
  display_name: 'Marta Ruiz',
  headline: 'COO, retail chain · looking for AI automation',
  company: 'Iberia Retail Group (demo)',
  short_bio:
    'Ищу подрядчика по AI-трансформации процессов: готова дать пилот и честную обратную связь.',
  languages: ['spanish', 'english'],
  offer_tags: ['b2b-clients', 'ai-pilots'],
  need_tags: ['ai-transformation', 'automation'],
  contacts: [
    { kind: 'telegram_username', value: '@marta_demo', public_enabled: true },
    { kind: 'whatsapp', value: '+34600000000', public_enabled: true },
  ],
} as const;

// The real owner profile the demo partner must match with (never modified).
const OWNER_DISPLAY_NAME = 'Nikita Berezniker';
const OWNER_EXPECTED_OFFERS = [
  'ai-transformation',
  'applied-ai',
  'automation',
  'sales-leadership',
  'process-design',
  'product-discovery',
  'rag',
  'mcp',
];
const OWNER_EXPECTED_NEEDS = ['b2b-clients', 'ai-pilots', 'sales-growth', 'partnerships'];

// Documented expectation for the owner<->partner geometry (see comment above).
const OWNER_PAIR_EXPECTED_SCORE = 60;
const OWNER_PAIR_EXPECTED_REASONS_FOR_OWNER = ['b2b-clients', 'ai-pilots'];
const OWNER_PAIR_EXPECTED_REASONS_FOR_PARTNER = ['ai-transformation', 'automation'];

/** Order-insensitive array equality (tag sets). */
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
}

// ---------------------------------------------------------------------------
// Europe/Madrid wall-clock -> UTC (DST-correct via Intl)
// ---------------------------------------------------------------------------
function madridParts(at: Date): Record<string, number> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: EVENT_TZ,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(at)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts;
}

function madridOffsetMinutes(at: Date): number {
  const p = madridParts(at);
  const asUtc = Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']! % 24, p['minute']!, p['second']!);
  return (asUtc - at.getTime()) / 60_000;
}

function madridLocalToUtc(dateStr: string, hh: number, mm: number): Date {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = madridOffsetMinutes(new Date(guess));
  const ts = guess - off * 60_000;
  const off2 = madridOffsetMinutes(new Date(ts));
  return new Date(ts - (off2 === off ? 0 : (off2 - off) * 60_000));
}

/** Next Saturday's date (YYYY-MM-DD) in the event's local calendar. */
function nextSaturdayLocal(): string {
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: EVENT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: EVENT_TZ, weekday: 'short' });
  const now = new Date();
  for (let ahead = 0; ahead <= 7; ahead++) {
    const probe = new Date(now.getTime() + ahead * 86_400_000);
    if (weekdayFmt.format(probe) === 'Sat') return dateFmt.format(probe);
  }
  throw new Error('could not compute next Saturday');
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------
async function findDemoAccount(email: string) {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM accounts WHERE email_lookup_hash = ${emailLookupHash(email, pepper)} LIMIT 1
  `;
  return rows[0] ?? null;
}

async function findProfile(accountId: string) {
  const rows = await sql<{ id: string; display_name: string; offer_tags: string[]; need_tags: string[] }[]>`
    SELECT id, display_name, offer_tags, need_tags FROM profiles WHERE account_id = ${accountId} LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Upserts
// ---------------------------------------------------------------------------
async function ensureDemo1Organizer(demo1AccountId: string): Promise<string> {
  const existing = await sql<{ organizer_id: string }[]>`
    SELECT organizer_id FROM organizer_members
    WHERE account_id = ${demo1AccountId} AND role = 'owner'
    LIMIT 1
  `;
  if (existing[0]) {
    console.log(`organizer owner already exists for demo1 — reusing organizer ${existing[0].organizer_id}`);
    return existing[0].organizer_id;
  }
  const rows = await sql<{ organizer_id: string }[]>`
    INSERT INTO organizers (display_name) VALUES (${ORGANIZER_NAME})
    RETURNING id AS organizer_id
  `;
  const organizerId = rows[0]!.organizer_id;
  await sql`
    INSERT INTO organizer_members (organizer_id, account_id, role)
    VALUES (${organizerId}, ${demo1AccountId}, 'owner')
    ON CONFLICT DO NOTHING
  `;
  console.log(`created demo organizer "${ORGANIZER_NAME}" (owner demo1, organizer ${organizerId})`);
  return organizerId;
}

async function upsertEvent(organizerId: string) {
  const saturday = nextSaturdayLocal();
  const startsAt = madridLocalToUtc(saturday, 18, 0);
  const endsAt = madridLocalToUtc(saturday, 21, 0);

  const existing = await sql<{ id: string; starts_at: Date; ends_at: Date }[]>`
    SELECT id, starts_at, ends_at FROM events WHERE slug = ${EVENT_SLUG} LIMIT 1
  `;

  if (existing[0]) {
    // Keep the schedule stable on re-runs unless the event already passed —
    // a live demo needs an upcoming date, so roll it to the next weekend.
    const refresh = existing[0].starts_at.getTime() < Date.now();
    await sql`
      UPDATE events SET
        organizer_id = ${organizerId},
        name = ${EVENT_NAME},
        access_mode = 'public',
        join_code = ${JOIN_CODE},
        mode = 'offline',
        timezone = ${EVENT_TZ},
        starts_at = ${refresh ? startsAt : existing[0].starts_at},
        ends_at = ${refresh ? endsAt : existing[0].ends_at},
        consent_text = ${CONSENT_TEXT},
        description = ${EVENT_DESCRIPTION},
        status = 'active'
      WHERE id = ${existing[0].id}
    `;
    console.log(
      `event ${EVENT_SLUG} already exists — updated (${refresh ? 'schedule rolled to next weekend' : 'schedule kept'})`,
    );
    return { id: existing[0].id, created: false };
  }

  const rows = await sql<{ id: string }[]>`
    INSERT INTO events (organizer_id, slug, name, mode, access_mode, max_participants,
                        location_label, description, consent_text, networking_window_days,
                        starts_at, ends_at, timezone, status)
    VALUES (${organizerId}, ${EVENT_SLUG}, ${EVENT_NAME}, 'offline', 'public', 200,
            'Madrid (demo venue)', ${EVENT_DESCRIPTION}, ${CONSENT_TEXT}, 30,
            ${startsAt}, ${endsAt}, ${EVENT_TZ}, 'active')
    RETURNING id
  `;
  console.log(`created event "${EVENT_NAME}" (${EVENT_SLUG}, join_code ${JOIN_CODE}, starts ${startsAt.toISOString()})`);
  return { id: rows[0]!.id, created: true };
}

async function upsertRegistration(eventId: string, guestNo: number, guest: { n: string; role: string; company: string; tags: string[] }) {
  const email = `demo-csv-${guestNo}@welcome.test`;
  const externalId = `demo-csv-${guestNo}`;
  const emailHash = emailLookupHash(email, pepper);
  const importedData = { email, name: guest.n, company: guest.company, role: guest.role, tags: guest.tags.join(', ') };
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM registrations
    WHERE event_id = ${eventId} AND provider = 'csv' AND external_guest_id = ${externalId}
    LIMIT 1
  `;
  if (existing[0]) {
    await sql`
      UPDATE registrations SET
        imported_name = ${guest.n},
        imported_data = ${sql.json(importedData)},
        approval_status = 'approved',
        email_lookup_hash = COALESCE(${emailHash}, email_lookup_hash),
        encrypted_email = COALESCE(${encryptValue(email, encKey)}, encrypted_email),
        claim_state = 'unclaimed',
        import_revision = import_revision + 1
      WHERE id = ${existing[0].id}
    `;
    return 'updated';
  }
  await sql`
    INSERT INTO registrations (event_id, provider, external_guest_id, email_lookup_hash, encrypted_email,
                               imported_name, imported_data, approval_status, claim_state)
    VALUES (${eventId}, 'csv', ${externalId}, ${emailHash}, ${encryptValue(email, encKey)},
            ${guest.n}, ${sql.json(importedData)}, 'approved', 'unclaimed')
  `;
  return 'created';
}

async function upsertDemoMembership(
  eventId: string,
  profile: { id: string; display_name: string },
  offers: readonly string[],
  needs: readonly string[],
) {
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM event_memberships WHERE event_id = ${eventId} AND profile_id = ${profile.id} LIMIT 1
  `;
  if (existing[0]) {
    await sql`
      UPDATE event_memberships SET
        state = 'active',
        directory_visible = true,
        matching_enabled = true,
        offer_tags = ${offers},
        need_tags = ${needs}
      WHERE id = ${existing[0].id}
    `;
    return 'updated';
  }
  await sql`
    INSERT INTO event_memberships (event_id, profile_id, state, directory_visible, matching_enabled, offer_tags, need_tags)
    VALUES (${eventId}, ${profile.id}, 'active', true, true, ${offers}, ${needs})
  `;
  return 'created';
}

// ---------------------------------------------------------------------------
// Demo partner upserts (synthetic account/profile/contacts)
// ---------------------------------------------------------------------------
async function ensurePartnerAccount(): Promise<{ id: string; created: boolean }> {
  const lookupHash = emailLookupHash(PARTNER_EMAIL, pepper);
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM accounts WHERE email_lookup_hash = ${lookupHash} LIMIT 1
  `;
  if (existing[0]) return { id: existing[0].id, created: false };

  const rows = await sql<{ id: string }[]>`
    INSERT INTO accounts (auth_subject, email_lookup_hash, is_demo)
    VALUES (${'email:' + lookupHash}, ${lookupHash}, true)
    ON CONFLICT (auth_subject) DO UPDATE SET is_demo = true
    RETURNING id
  `;
  return { id: rows[0]!.id, created: true };
}

async function ensurePartnerProfile(
  accountId: string,
): Promise<{ id: string; public_slug: string; created: boolean }> {
  const existing = await sql<{ id: string; public_slug: string }[]>`
    SELECT id, public_slug FROM profiles WHERE account_id = ${accountId} LIMIT 1
  `;
  if (existing[0]) {
    await sql`
      UPDATE profiles SET
        display_name = ${PARTNER.display_name},
        headline = ${PARTNER.headline},
        company = ${PARTNER.company},
        short_bio = ${PARTNER.short_bio},
        languages = ${PARTNER.languages},
        offer_tags = ${PARTNER.offer_tags},
        need_tags = ${PARTNER.need_tags},
        updated_at = now()
      WHERE id = ${existing[0].id}
    `;
    return { id: existing[0].id, public_slug: existing[0].public_slug, created: false };
  }

  const rows = await sql<{ id: string; public_slug: string }[]>`
    INSERT INTO profiles (account_id, public_slug, display_name, headline, company, short_bio,
                          languages, offer_tags, need_tags)
    VALUES (${accountId}, ${generatePublicSlug()}, ${PARTNER.display_name}, ${PARTNER.headline},
            ${PARTNER.company}, ${PARTNER.short_bio}, ${PARTNER.languages},
            ${PARTNER.offer_tags}, ${PARTNER.need_tags})
    RETURNING id, public_slug
  `;
  return { id: rows[0]!.id, public_slug: rows[0]!.public_slug, created: true };
}

/** Contacts are AES-256-GCM ciphertext at rest; upsert per (profile_id, kind). */
async function upsertPartnerContacts(profileId: string): Promise<string[]> {
  const outcomes: string[] = [];
  for (const c of PARTNER.contacts) {
    const rows = await sql<{ inserted: boolean }[]>`
      INSERT INTO contact_fields (profile_id, kind, encrypted_value, public_enabled)
      VALUES (${profileId}, ${c.kind}, ${encryptValue(c.value, encKey)}, ${c.public_enabled})
      ON CONFLICT (profile_id, kind)
        DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
                      public_enabled = EXCLUDED.public_enabled,
                      verified_at = NULL,
                      updated_at = now()
      RETURNING (xmax = 0) AS inserted
    `;
    outcomes.push(`${c.kind}:${rows[0]!.inserted ? 'created' : 'updated'}`);
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Real owner lookup + read-only membership checks
// ---------------------------------------------------------------------------
async function findOwnerProfile() {
  const rows = await sql<{ id: string; account_id: string; display_name: string }[]>`
    SELECT pr.id, pr.account_id, pr.display_name
    FROM profiles pr
    JOIN accounts a ON a.id = pr.account_id
    WHERE pr.display_name = ${OWNER_DISPLAY_NAME} AND a.is_demo = false
    ORDER BY pr.created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** Effective (membership override else profile) matching view of a membership. */
async function readMembershipView(eventId: string, profileId: string) {
  const rows = await sql<
    { state: string; directory_visible: boolean; matching_enabled: boolean; needs: string[]; offers: string[] }[]
  >`
    SELECT m.state, m.directory_visible, m.matching_enabled,
           COALESCE(NULLIF(m.need_tags, '{}'), pr.need_tags) AS needs,
           COALESCE(NULLIF(m.offer_tags, '{}'), pr.offer_tags) AS offers
    FROM event_memberships m
    JOIN profiles pr ON pr.id = m.profile_id
    WHERE m.event_id = ${eventId} AND m.profile_id = ${profileId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Matching proof + the mutual introduction
// ---------------------------------------------------------------------------
/** Upsert one canonical event-context pair as mutual with accept consents on both sides. */
async function upsertMutualIntro(
  eventId: string,
  profileA: string,
  profileB: string,
  reason: { reasons_for_a: string[]; reasons_for_b: string[]; algorithm: string },
): Promise<string> {
  const inserted = await sql<{ id: string; inserted: boolean }[]>`
    INSERT INTO introductions (event_id, profile_a, profile_b, context_key, reason, state)
    VALUES (${eventId}, ${profileA}, ${profileB}, ${eventContextKey(eventId)}, ${sql.json(reason)}, 'mutual')
    ON CONFLICT (context_key, profile_a, profile_b)
      DO UPDATE SET state = 'mutual', reason = EXCLUDED.reason, event_id = EXCLUDED.event_id
    RETURNING id, (xmax = 0) AS inserted
  `;
  const introId = inserted[0]!.id;

  const consents = await sql`
    INSERT INTO introduction_consents (introduction_id, profile_id, decision, reveal_fields, version)
    VALUES
      (${introId}, ${profileA}, 'accept', ARRAY['telegram_username', 'whatsapp'], 1),
      (${introId}, ${profileB}, 'accept', ARRAY['telegram_username', 'whatsapp'], 1)
    ON CONFLICT (introduction_id, profile_id)
      DO UPDATE SET decision = 'accept', reveal_fields = EXCLUDED.reveal_fields, version = introduction_consents.version + 1,
                    updated_at = now()
    RETURNING profile_id
  `;
  console.log(
    `mutual introduction ${inserted[0]!.inserted ? 'created' : 'updated'} (id ${introId}); ` +
      `consents accept on ${consents.length} side(s), reveal ['telegram_username','whatsapp'] both ways`,
  );
  return introId;
}

async function verifyAndUpsertIntro(
  eventId: string,
  demo1: { id: string; profile: { id: string; display_name: string } },
  demo2: { id: string; profile: { id: string; display_name: string } },
) {
  const pair = canonicalPair(demo1.profile.id, demo2.profile.id);
  const ctx = eventContextKey(eventId);

  // Reason snapshot aligned with the canonical pair order (profile_a = min uuid),
  // exactly like the API route stores it: a: demo1 tags (needs/offers), b: demo2.
  const demo1Tags = { needs: EVENT_NEEDS, offers: EVENT_OFFERS };
  const demo2Tags = { needs: EVENT_OFFERS, offers: EVENT_NEEDS };
  const aIsDemo1 = pair.profileA === demo1.profile.id;
  const match = scorePair(
    { id: pair.profileA, eligible: true, ...(aIsDemo1 ? demo1Tags : demo2Tags) },
    { id: pair.profileB, eligible: true, ...(aIsDemo1 ? demo2Tags : demo1Tags) },
  );
  if (!match) throw new Error('demo tag geometry must produce a mutual match');
  console.log(
    `scorePair demo1<->demo2 = ${match.score} ` +
      `(reasons_for_a: ${match.reasonsForA.join(', ') || '-'}; reasons_for_b: ${match.reasonsForB.join(', ') || '-'})`,
  );

  // Live recommendation proof (only meaningful while no event-context intro
  // exists yet — an existing pair is excluded by the cooldown rule).
  const existingIntro = await sql<{ id: string }[]>`
    SELECT id FROM introductions
    WHERE context_key = ${ctx} AND profile_a = ${pair.profileA} AND profile_b = ${pair.profileB}
    LIMIT 1
  `;
  if (!existingIntro[0]) {
    for (const [viewer, other] of [
      [demo1, demo2],
      [demo2, demo1],
    ] as const) {
      const recs = await recommendForEvent(sql, { accountId: viewer.id, profileId: viewer.profile.id }, eventId);
      const hit = recs.find((r) => r.profile_id === other.profile.id);
      if (!hit || hit.score !== 100) {
        throw new Error(`recommendation check failed for ${viewer.profile.display_name}: expected demo2 score 100`);
      }
      console.log(
        `recommendations for ${viewer.profile.display_name}: ${other.profile.display_name} score ${hit.score} ` +
          `(for_me: ${hit.reasons_for_me.join(', ')})`,
      );
    }
  } else {
    console.log('mutual intro already exists — recommendation check skipped (pair excluded by cooldown rule); scorePair above is the proof');
  }

  const reason = { reasons_for_a: match.reasonsForA, reasons_for_b: match.reasonsForB, algorithm: match.algorithm };
  return upsertMutualIntro(eventId, pair.profileA, pair.profileB, reason);
}

// ---------------------------------------------------------------------------
// Real-owner <-> demo-partner proof + intro
// ---------------------------------------------------------------------------
/**
 * Verifies the owner<->partner geometry against the frozen formula, then (while
 * no pair exists yet) against the live server-side recommendation path, and
 * finally stores the mutual intro. The owner's profile/membership is read-only:
 * a missing or non-eligible membership is a hard error, not something we patch.
 */
async function verifyAndUpsertOwnerIntro(
  eventId: string,
  owner: { account_id: string; profile_id: string; display_name: string; membership: { needs: string[]; offers: string[] } },
  partnerProfileId: string,
) {
  const pair = canonicalPair(owner.profile_id, partnerProfileId);
  const ctx = eventContextKey(eventId);

  // Viewer-oriented match: owner as A, partner as B.
  const match = scorePair(
    { id: owner.profile_id, eligible: true, needs: owner.membership.needs, offers: owner.membership.offers },
    { id: partnerProfileId, eligible: true, needs: PARTNER.need_tags, offers: PARTNER.offer_tags },
  );
  if (!match) {
    throw new Error(
      `owner<->partner tag geometry must produce a mutual match (owner offers=[${owner.membership.offers.join(', ')}] ` +
        `needs=[${owner.membership.needs.join(', ')}])`,
    );
  }

  const dAB = match.reasonsForA.length / Math.max(1, owner.membership.needs.length);
  const dBA = match.reasonsForB.length / Math.max(1, PARTNER.need_tags.length);
  console.log(
    `scorePair ${owner.display_name}<->${PARTNER.display_name} = ${match.score} ` +
      `(d(owner→partner)=${dAB}, d(partner→owner)=${dBA}; ` +
      `reasons_for_owner: ${match.reasonsForA.join(', ') || '-'}; reasons_for_partner: ${match.reasonsForB.join(', ') || '-'})`,
  );

  if (!sameTags(owner.membership.offers, OWNER_EXPECTED_OFFERS) || !sameTags(owner.membership.needs, OWNER_EXPECTED_NEEDS)) {
    throw new Error(
      `owner effective event tags differ from the demo expectation: ` +
        `offers=[${owner.membership.offers.join(', ')}] (expected [${OWNER_EXPECTED_OFFERS.join(', ')}]), ` +
        `needs=[${owner.membership.needs.join(', ')}] (expected [${OWNER_EXPECTED_NEEDS.join(', ')}])`,
    );
  }
  if (
    match.score !== OWNER_PAIR_EXPECTED_SCORE ||
    !sameTags(match.reasonsForA, OWNER_PAIR_EXPECTED_REASONS_FOR_OWNER) ||
    !sameTags(match.reasonsForB, OWNER_PAIR_EXPECTED_REASONS_FOR_PARTNER)
  ) {
    throw new Error(
      `owner<->partner score geometry drifted: got score ${match.score} ` +
        `(reasons_for_owner: ${match.reasonsForA.join(', ') || '-'}; reasons_for_partner: ${match.reasonsForB.join(', ') || '-'}), ` +
        `expected score ${OWNER_PAIR_EXPECTED_SCORE} ` +
        `(reasons_for_owner: ${OWNER_PAIR_EXPECTED_REASONS_FOR_OWNER.join(', ')}; ` +
        `reasons_for_partner: ${OWNER_PAIR_EXPECTED_REASONS_FOR_PARTNER.join(', ')})`,
    );
  }
  console.log(
    `owner<->partner geometry ok: score ${match.score} (0.6*min(${dAB},${dBA}) + 0.4*(${dAB}+${dBA})/2 = ${match.score / 100})`,
  );

  // Live recommendation proof (only meaningful before the pair exists — an
  // existing pair is excluded by the event intro cooldown rule).
  const existingIntro = await sql<{ id: string }[]>`
    SELECT id FROM introductions
    WHERE context_key = ${ctx} AND profile_a = ${pair.profileA} AND profile_b = ${pair.profileB}
    LIMIT 1
  `;
  if (!existingIntro[0]) {
    const recs = await recommendForEvent(sql, { accountId: owner.account_id, profileId: owner.profile_id }, eventId);
    const hit = recs.find((r) => r.profile_id === partnerProfileId);
    if (!hit) {
      throw new Error(
        `recommendForEvent did not return ${PARTNER.display_name} for ${owner.display_name}; ` +
          `got: ${recs.map((r) => `${r.display_name}=${r.score}`).join(', ') || '(none)'}`,
      );
    }
    if (
      hit.score !== match.score ||
      !sameTags(hit.reasons_for_me, match.reasonsForA) ||
      !sameTags(hit.reasons_for_them, match.reasonsForB)
    ) {
      throw new Error(
        `recommendForEvent disagrees with scorePair for ${PARTNER.display_name}: ` +
          `recommendation score ${hit.score} (for_me: ${hit.reasons_for_me.join(', ') || '-'}; for_them: ${hit.reasons_for_them.join(', ') || '-'})`,
      );
    }
    console.log(
      `recommendations for ${owner.display_name}: ${hit.display_name} score ${hit.score} ` +
        `(for_me: ${hit.reasons_for_me.join(', ')}; for_them: ${hit.reasons_for_them.join(', ')})`,
    );
  } else {
    console.log(
      `owner<->partner intro already exists — recommendation check skipped (pair excluded by cooldown rule); ` +
        `scorePair above is the proof`,
    );
  }

  const aIsOwner = pair.profileA === owner.profile_id;
  const reason = {
    reasons_for_a: aIsOwner ? match.reasonsForA : match.reasonsForB,
    reasons_for_b: aIsOwner ? match.reasonsForB : match.reasonsForA,
    algorithm: match.algorithm,
  };
  return upsertMutualIntro(eventId, pair.profileA, pair.profileB, reason);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const demo1Account = await findDemoAccount('demo1@welcome.test');
const demo2Account = await findDemoAccount('demo2@welcome.test');
if (!demo1Account || !demo2Account) {
  console.error('demo1@welcome.test / demo2@welcome.test account(s) missing — run db:seed first');
  process.exit(1);
}
const demo1Profile = await findProfile(demo1Account.id);
const demo2Profile = await findProfile(demo2Account.id);
if (!demo1Profile || !demo2Profile) {
  console.error('demo profile missing for an existing demo account');
  process.exit(1);
}

const organizerId = await ensureDemo1Organizer(demo1Account.id);
const { id: eventId, created: eventCreated } = await upsertEvent(organizerId);

let regCreated = 0;
let regUpdated = 0;
for (let i = 0; i < GUESTS.length; i++) {
  const outcome = await upsertRegistration(eventId, i + 1, GUESTS[i]!);
  if (outcome === 'created') regCreated++;
  else regUpdated++;
}
console.log(`registrations: ${regCreated} created, ${regUpdated} updated (demo-csv-1..${GUESTS.length}, unclaimed)`);

const m1 = await upsertDemoMembership(eventId, demo1Profile, EVENT_OFFERS, EVENT_NEEDS);
const m2 = await upsertDemoMembership(eventId, demo2Profile, EVENT_NEEDS, EVENT_OFFERS);
console.log(
  `memberships: demo1 ${m1} (directory_visible, matching_enabled, offers=${EVENT_OFFERS.join(',')}, needs=${EVENT_NEEDS.join(',')}); ` +
    `demo2 ${m2} (offers=${EVENT_NEEDS.join(',')}, needs=${EVENT_OFFERS.join(',')})`,
);

await verifyAndUpsertIntro(eventId, { ...demo1Account, profile: demo1Profile }, { ...demo2Account, profile: demo2Profile });

// ---------------------------------------------------------------------------
// Synthetic demo partner for the REAL owner account (match + intro demo)
// ---------------------------------------------------------------------------
const partnerAccount = await ensurePartnerAccount();
const partnerProfile = await ensurePartnerProfile(partnerAccount.id);
const contactOutcomes = await upsertPartnerContacts(partnerProfile.id);
const pMembership = await upsertDemoMembership(eventId, partnerProfile, PARTNER.offer_tags, PARTNER.need_tags);
console.log(
  `demo partner ${PARTNER.display_name}: account ${partnerAccount.created ? 'created' : 'reused'} ` +
    `(is_demo, ${PARTNER_EMAIL}); profile ${partnerProfile.created ? 'created' : 'updated'} ` +
    `(/p/${partnerProfile.public_slug}, ${partnerProfile.id}); contacts [${contactOutcomes.join(', ')}]; ` +
    `membership ${pMembership} (directory_visible, matching_enabled, offers=${PARTNER.offer_tags.join(',')}, ` +
    `needs=${PARTNER.need_tags.join(',')})`,
);

const ownerProfile = await findOwnerProfile();
if (!ownerProfile) {
  console.error(
    `REFUSED: real owner profile "${OWNER_DISPLAY_NAME}" not found (is_demo = false). The demo partner exists only ` +
      `to match the real owner account — create/rename it first, or set the expected name in this seeder.`,
  );
  process.exit(1);
}
const ownerMembership = await readMembershipView(eventId, ownerProfile.id);
if (!ownerMembership) {
  console.error(
    `REFUSED: "${ownerProfile.display_name}" is not a member of ${EVENT_SLUG}. Join the event with the owner ` +
      `account first (this seeder never writes to the real profile/membership).`,
  );
  process.exit(1);
}
if (ownerMembership.state !== 'active' || !ownerMembership.directory_visible || !ownerMembership.matching_enabled) {
  console.error(
    `REFUSED: owner membership in ${EVENT_SLUG} is not match-eligible (state=${ownerMembership.state}, ` +
      `directory_visible=${ownerMembership.directory_visible}, matching_enabled=${ownerMembership.matching_enabled}).`,
  );
  process.exit(1);
}
await verifyAndUpsertOwnerIntro(
  eventId,
  {
    account_id: ownerProfile.account_id,
    profile_id: ownerProfile.id,
    display_name: ownerProfile.display_name,
    membership: { needs: ownerMembership.needs, offers: ownerMembership.offers },
  },
  partnerProfile.id,
);

console.log(`seed-demo-event done: event ${eventCreated ? 'created' : 'updated'} (${EVENT_SLUG}, id ${eventId})`);
await sql.end({ timeout: 5 });

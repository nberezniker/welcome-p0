#!/usr/bin/env node
// DEV ONLY: seeds 2 demo accounts/profiles (is_demo = true).
// Refuses to run when APP_ENV=production. Run with: pnpm db:seed (tsx loader).
import postgres from 'postgres';
import { emailLookupHash, encryptValue, generatePublicSlug } from '../src/lib/crypto.ts';
import { isProduction } from '../src/lib/env.ts';

if (isProduction()) {
  console.error('REFUSED: db:seed cannot run when APP_ENV=production');
  process.exit(1);
}

const pepper = process.env.HASH_PEPPER;
if (!pepper) {
  console.error('HASH_PEPPER is required to seed accounts (email lookup hashes)');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL || 'postgres://localhost:5432/welcome_dev';
const sql = postgres(databaseUrl, { max: 1 });

const demos = [
  {
    email: 'demo1@welcome.test',
    display_name: 'Анна Смирнова',
    headline: 'Product Designer',
    company: 'Freelance',
    short_bio: 'Дизайн интерфейсов и исследования пользователей. Люблю быстрые прототипы.',
    languages: ['ru', 'en'],
    offer_tags: ['design', 'ux', 'prototyping'],
    need_tags: ['pilot users', 'feedback'],
    contacts: [
      { kind: 'telegram_username', value: '@anna_demo', public_enabled: true },
      { kind: 'phone', value: '+79000000001', public_enabled: false },
    ],
  },
  {
    email: 'demo2@welcome.test',
    display_name: 'Дмитрий Ковалёв',
    headline: 'Founder, early-stage startup',
    company: 'Stealth',
    short_bio: 'Строю B2B-продукт, ищу первых пользователей и партнёров.',
    languages: ['ru'],
    offer_tags: ['pilot', 'b2b'],
    need_tags: ['design', 'ux'],
    contacts: [{ kind: 'telegram_username', value: '@dmitry_demo', public_enabled: true }],
  },
];

let created = 0;
let skipped = 0;
for (const demo of demos) {
  const lookupHash = emailLookupHash(demo.email, pepper);
  let rows = await sql<{ id: string }>`
    INSERT INTO accounts (auth_subject, email_lookup_hash, is_demo)
    VALUES (${'email:' + lookupHash}, ${lookupHash}, true)
    ON CONFLICT (auth_subject) DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0) {
    rows = await sql<{ id: string }>`SELECT id FROM accounts WHERE email_lookup_hash = ${lookupHash} LIMIT 1`;
  }
  const account = rows[0];
  if (!account) throw new Error(`failed to upsert account for ${demo.email}`);

  const existingProfile = await sql<{ id: string }>`SELECT id FROM profiles WHERE account_id = ${account.id} LIMIT 1`;
  if (existingProfile.length > 0) {
    skipped++;
    console.log(`profile for ${demo.email} already exists — skipped`);
    continue;
  }

  const slug = generatePublicSlug();
  const profileRows = await sql<{ id: string; public_slug: string }>`
    INSERT INTO profiles (account_id, public_slug, display_name, headline, company, short_bio, languages, offer_tags, need_tags)
    VALUES (${account.id}, ${slug}, ${demo.display_name}, ${demo.headline}, ${demo.company}, ${demo.short_bio},
            ${demo.languages}, ${demo.offer_tags}, ${demo.need_tags})
    RETURNING id, public_slug
  `;
  const profile = profileRows[0];
  if (!profile) throw new Error('failed to insert demo profile');

  if (process.env.ENCRYPTION_KEY) {
    for (const c of demo.contacts) {
      await sql`
        INSERT INTO contact_fields (profile_id, kind, encrypted_value, public_enabled)
        VALUES (${profile.id}, ${c.kind}, ${encryptValue(c.value, process.env.ENCRYPTION_KEY)}, ${c.public_enabled})
      `;
    }
  } else {
    console.log('ENCRYPTION_KEY not set — demo contacts skipped');
  }

  created++;
  console.log(`seeded ${demo.display_name}: /p/${slug}`);
}

// DEV ONLY: when TELEGRAM_MOCK=1, bind the first demo account to a fake
// Telegram chat so the worker + mock transport deliver demo notifications.
// Never runs in production (guarded above) and never without the explicit flag.
if (process.env.TELEGRAM_MOCK === '1') {
  const first = await sql<{ id: string }>`
    SELECT a.id FROM accounts a JOIN profiles p ON p.account_id = a.id
    WHERE a.is_demo = true ORDER BY a.created_at LIMIT 1
  `;
  if (first[0]) {
    await sql`
      INSERT INTO channel_bindings (account_id, provider, external_id, state)
      VALUES (${first[0].id}, 'telegram', '7000000001', 'active')
      ON CONFLICT (provider, external_id) DO UPDATE SET state = 'active'
    `;
    console.log('mock telegram binding created for demo account (chat_id 7000000001)');
  }
}

console.log(`seed-demo done: ${created} created, ${skipped} skipped`);
await sql.end({ timeout: 5 });

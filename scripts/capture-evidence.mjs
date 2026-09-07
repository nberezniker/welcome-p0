// Evidence screenshot capture (Phase 4 acceptance).
// Prerequisites: dev server running on $E2E_BASE_URL (default 127.0.0.1:3111)
// with the e2e env (see playwright.config.ts webServer.env) — e.g.:
//   DATABASE_URL=postgres://localhost:5432/welcome_e2e APP_ENV=development \
//   AUTH_DEV_EXPOSE_OTP=true HASH_PEPPER=e2e-pepper-0123456789abcdef \
//   ENCRYPTION_KEY=$(base64 of 32 bytes) APP_BASE_URL=http://127.0.0.1:3111 \
//   pnpm exec next dev -p 3111
// The script resets the welcome_e2e schema, replays a full scenario and saves
// screenshots to evidence/screenshots/.
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { mkdirSync } from 'node:fs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3111';
const databaseUrl = process.env.E2E_DATABASE_URL || 'postgres://localhost:5432/welcome_e2e';
const OUT = path.join(ROOT, 'evidence', 'screenshots');
mkdirSync(OUT, { recursive: true });

const A = { email: 'alice@evidence.example.org', name: 'Alice Nova', wa: '+34600111111', phone: '+34600222222' };
const B = { email: 'bob@evidence.example.org', name: 'Bob Marlow', wa: '+34600333333' };
const SLUG = 'evidence-mixer';

async function resetDb() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await sql.unsafe('CREATE SCHEMA public');
    await sql.unsafe('GRANT ALL ON SCHEMA public TO current_user');
  } finally {
    await sql.end({ timeout: 5 });
  }
  const r = spawnSync('node', ['scripts/migrate.mjs'], { stdio: 'inherit', cwd: ROOT, env: { ...process.env, DATABASE_URL: databaseUrl } });
  if (r.status !== 0) throw new Error('migrations failed');
}

async function waitHydrated(page) {
  await page.waitForSelector('html[data-hydrated="true"]', { state: 'attached', timeout: 30_000 });
}

async function loginViaOtp(page, email) {
  await page.goto(`${baseURL}/login`);
  await waitHydrated(page);
  await page.getByTestId('login-email').fill(email);
  const rp = page.waitForResponse((r) => r.url().includes('/api/auth/otp/request'));
  await page.getByTestId('login-request').click();
  const body = await (await rp).json();
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL('**/me');
}

async function createProfile(page, name, headline, offer, need) {
  await page.goto(`${baseURL}/me/profile`);
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill(name);
  await page.locator('#pf-headline').fill(headline);
  await page.locator('#pf-offer').fill(offer);
  await page.keyboard.press('Enter');
  await page.locator('#pf-need').fill(need);
  await page.keyboard.press('Enter');
  await page.getByTestId('pf-save').click();
  await page.waitForSelector('[data-testid=toast-success]');
}

async function addContact(page, kind, value, publish) {
  await page.goto(`${baseURL}/me/contacts`);
  await waitHydrated(page);
  await page.locator(`#contact-value-${kind}`).fill(value);
  if (publish) await page.locator(`#contact-public-${kind}`).check();
  await page.getByTestId(`contact-save-${kind}`).click();
  await page.waitForSelector('[data-testid=toast-success]');
}

async function joinAndOptIn(page) {
  await page.goto(`${baseURL}/e/${SLUG}`);
  await waitHydrated(page);
  await page.getByTestId('join-button').click();
  await page.waitForSelector('[data-testid=member-panel]');
  await waitHydrated(page);
  await page.getByTestId('event-directory-toggle').check();
}

const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageA = await ctxA.newPage();
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageB = await ctxB.newPage();

await resetDb();

// ── Landing screenshots (360 + 1440, en/ru) ────────────────────────────────
const landing = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await landing.goto(`${baseURL}/`);
await waitHydrated(landing);
await landing.screenshot({ path: `${OUT}/landing-1440-en.png`, fullPage: true });
await landing.getByTestId('locale-switcher').getByRole('button', { name: /RU/i }).click();
await landing.waitForSelector('html[lang="ru"]');
await landing.screenshot({ path: `${OUT}/landing-1440-ru.png`, fullPage: true });
await landing.setViewportSize({ width: 360, height: 780 });
await landing.waitForTimeout(400);
await landing.screenshot({ path: `${OUT}/landing-360-ru.png`, fullPage: true });
const overflow = await landing.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log('overflow at 360px:', overflow, 'px');
await landing.getByTestId('locale-switcher').getByRole('button', { name: /: EN/i }).click();
await landing.waitForSelector('html[lang="en"]');
await landing.setViewportSize({ width: 360, height: 780 });
await landing.waitForTimeout(400);
await landing.screenshot({ path: `${OUT}/landing-360-en.png`, fullPage: true });
await landing.close();

// ── Account A ───────────────────────────────────────────────────────────────
await loginViaOtp(pageA, A.email);
await createProfile(pageA, A.name, 'Backend engineer', 'pilot-integrations', 'saas-distribution');
await pageA.screenshot({ path: `${OUT}/profile-editor.png`, fullPage: true });
await addContact(pageA, 'whatsapp', A.wa, true);
await addContact(pageA, 'phone', A.phone, false);

// public URL for the public-card shot
await pageA.goto(`${baseURL}/me`);
const publicUrl = await pageA.getByTestId('public-url').textContent();
await pageA.screenshot({ path: `${OUT}/me-dashboard.png`, fullPage: true });

// event creation via organizer UI
await pageA.goto(`${baseURL}/organizer`);
await waitHydrated(pageA);
await pageA.getByTestId('ev-name').fill('Evidence Founders Mixer');
await pageA.locator('#ev-tz').selectOption('Europe/Madrid');
await pageA.locator('#ev-slug').fill(SLUG);
await pageA.getByTestId('ev-submit').click();
await pageA.waitForURL('**/organizer/events/**');
const eventId = pageA.url().split('/').pop();
await joinAndOptIn(pageA);

// ── Account B ───────────────────────────────────────────────────────────────
await loginViaOtp(pageB, B.email);
await createProfile(pageB, B.name, 'Growth advisor', 'saas-distribution', 'pilot-integrations');
await addContact(pageB, 'whatsapp', B.wa, true);
await joinAndOptIn(pageB);
// grant organizer announcements at event scope (for the campaign audience)
await pageB.getByTestId('event-marketing-toggle').check();

// ── Campaign: create → approve → send ──────────────────────────────────────
await pageA.goto(`${baseURL}/organizer/events/${eventId}/campaigns`);
await waitHydrated(pageA);
await pageA.locator('#camp-body').fill('Reminder: networking hour starts at 18:00. Bring your QR!');
await pageA.getByRole('button', { name: 'Create draft' }).click();
await pageA.waitForSelector('[data-testid^="campaign-"]');
await pageA.locator('[data-testid^="campaign-approve-"]').click();
await pageA.waitForSelector('[data-testid^="campaign-send-"]');
await pageA.locator('[data-testid^="campaign-send-"]').click();
await pageA.getByTestId('confirm-send').click();
await pageA.waitForTimeout(1500);
await pageA.locator('[data-testid^="campaign-stats-"]').click();
await pageA.waitForSelector('[data-testid^="stats-"]');
await pageA.screenshot({ path: `${OUT}/organizer-campaign-stats.png`, fullPage: true });

// ── Intro: B proposes, A accepts, B accepts → mutual ────────────────────────
await pageB.goto(`${baseURL}/me/events/${eventId}/directory`);
await waitHydrated(pageB);
await pageB.waitForSelector('[data-testid=member-list]');
await pageB.screenshot({ path: `${OUT}/event-directory.png`, fullPage: true });
await pageB.locator('[data-testid=member-list] li').first().getByRole('button').first().click();
await pageB.locator('fieldset input[type=checkbox]').first().check();
await pageB.getByTestId('send-intro').click();
await pageB.waitForSelector('[data-testid=toast-success]');

await pageA.goto(`${baseURL}/me/introductions`);
await waitHydrated(pageA);
await pageA.locator('fieldset input[type=checkbox]').first().check();
await pageA.getByRole('button', { name: 'Accept' }).click();
await pageA.waitForTimeout(1200);

await pageB.goto(`${baseURL}/me/introductions`);
await waitHydrated(pageB);
await pageB.locator('fieldset input[type=checkbox]').first().check();
await pageB.getByRole('button', { name: 'Accept' }).click();
await pageB.waitForTimeout(1200);
await pageB.reload();
await pageB.waitForSelector('[data-testid^="intro-revealed"]');
await pageB.screenshot({ path: `${OUT}/intro-reveal-panel.png`, fullPage: true });

// ── Public card (fresh anonymous context, mobile) ──────────────────────────
const anon = await browser.newContext({ viewport: { width: 360, height: 780 } });
const anonPage = await anon.newPage();
await anonPage.goto(publicUrl);
await anonPage.screenshot({ path: `${OUT}/public-card-mobile.png`, fullPage: true });
await anon.close();

await ctxA.close();
await ctxB.close();
await browser.close();
console.log('evidence screenshots written to', OUT);

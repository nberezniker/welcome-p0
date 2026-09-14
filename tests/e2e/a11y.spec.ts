import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Accessibility gate (axe).
 *
 * Rule: zero violations of impact `serious` or `critical` on the public pages
 * and on the authenticated security screen. `moderate`/`minor` findings are
 * reported in the run output but do not fail the gate — a cosmetic nit must
 * never be able to mask a real one, and conversely a real one must not hide
 * behind the first cosmetic one.
 *
 * Findings are accumulated across every page and asserted ONCE at the end, so a
 * failing run shows the whole picture instead of only the first page.
 */

const A11Y_EMAIL = 'a11y-owner@example.org';
const GATED_IMPACTS = ['serious', 'critical'] as const;

interface Finding {
  page: string;
  id: string;
  impact: string;
  help: string;
  targets: string[];
}

/** Human-readable failure so a broken gate says WHAT broke and WHERE. */
function describe(findings: Finding[]): string {
  return findings.map((f) => `${f.page} :: ${f.id} [${f.impact}] ${f.help} → ${f.targets.join(' | ')}`).join('\n');
}

async function scan(page: Page, label: string, findings: Finding[]): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  console.log(`[a11y] ${label}: ${results.violations.length} violation type(s) in total`);
  for (const v of results.violations) {
    const impact = v.impact ?? 'unknown';
    const targets = v.nodes.slice(0, 4).map((n) => n.target.join(' '));
    console.log(`  - ${v.id} [${impact}] ${v.help} (${v.nodes.length} node(s)) → ${targets.join(' | ')}`);
    for (const node of v.nodes.slice(0, 2)) console.log(`      ${node.html.slice(0, 180)}`);
    if ((GATED_IMPACTS as readonly string[]).includes(impact)) {
      findings.push({
        page: label,
        id: v.id,
        impact,
        help: v.help,
        targets: v.nodes.slice(0, 8).map((n) => `${n.target.join(' ')} { ${n.html.slice(0, 120)} }`),
      });
    }
  }
}

async function waitHydrated(page: Page) {
  await expect(page.locator('html[data-hydrated="true"]')).toBeAttached({ timeout: 30_000 });
}

async function loginViaOtp(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await waitHydrated(page);
  await page.getByTestId('login-email').fill(email);
  const responsePromise = page.waitForResponse(
    (r) => r.url().includes('/api/auth/otp/request') && r.request().method() === 'POST',
  );
  await page.getByTestId('login-request').click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { ok: boolean; devCode?: string };
  if (!body.devCode) throw new Error('devCode missing from the OTP request response');
  await page.getByTestId('login-code').fill(body.devCode);
  await page.getByTestId('login-verify').click();
  await page.waitForURL(/\/(me|onboarding)$/, { timeout: 30_000 });
}

test('a11y: no serious or critical violations on the gated pages', async ({ page }) => {
  const findings: Finding[] = [];

  for (const path of ['/', '/login', '/legal/privacy']) {
    await page.goto(path);
    await waitHydrated(page);
    await scan(page, path, findings);
  }

  // /p/<slug> and /me/security need a real session and a real profile.
  await loginViaOtp(page, A11Y_EMAIL);

  await page.goto('/me/profile');
  await waitHydrated(page);
  await page.getByTestId('pf-name').fill('A11y Owner');
  await page.getByTestId('pf-save').click();
  await expect(page.getByTestId('toast-success')).toBeVisible();

  await page.goto('/me');
  await waitHydrated(page);
  const publicUrl = (await page.getByTestId('public-url').textContent())?.trim() ?? '';
  expect(publicUrl).toContain('/p/');
  const cardPath = new URL(publicUrl).pathname;

  await page.goto(cardPath);
  await waitHydrated(page);
  await scan(page, cardPath, findings);

  await page.goto('/me/security');
  await waitHydrated(page);
  await scan(page, '/me/security', findings);

  expect(findings, `serious/critical a11y violations:\n${describe(findings)}`).toEqual([]);
});

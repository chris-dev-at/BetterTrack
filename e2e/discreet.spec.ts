import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { newAdminRequestContext } from './support/adminApi';
import { cashSourceAction, cashSourceRow } from './support/cashSurface';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/** Mutating API calls need this header or the CSRF guard 403s them. */
const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' };

/**
 * Flip the same discreet setting through the compact surface available at the
 * current viewport: the desktop rail menu or the phone-sized Control Center.
 */
async function flipDiscreetMode(page: Page, enabled: boolean): Promise<void> {
  const accountMenu = page.getByRole('button', { name: /Account menu/i });
  if (await accountMenu.isVisible()) {
    await accountMenu.click();
    const toggle = page.getByRole('menuitemcheckbox', { name: /Discreet mode/i });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', String(!enabled));
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(enabled));
    await page.keyboard.press('Escape');
    return;
  }

  await page.goto('/control/privacy');
  const toggle = page.getByRole('switch', { name: /Discreet mode/i });
  await expect(toggle).toBeVisible();
  if (enabled) {
    await expect(toggle).not.toBeChecked();
  } else {
    await expect(toggle).toBeChecked();
  }
  await toggle.click();
  if (enabled) {
    await expect(toggle).toBeChecked();
  } else {
    await expect(toggle).not.toBeChecked();
  }
}

/**
 * V5-P13 arc (a) — discreet mode (#682). One user, one profile-menu quick
 * toggle. The user provisions a portfolio, seeds a manual cash movement and
 * holding so real absolute amounts render on the portfolio surface, flips discreet mode
 * ON via the profile menu, and asserts EVERY euro symbol has left the
 * portfolio page (the sweep the acceptance criteria call for) — the masked
 * placeholder `•••` appears in its place. Toggling discreet mode back OFF
 * restores the exact amount, byte-identical. Persistence is proven by a
 * hard reload with discreet on: the toggle state and mask survive.
 */
test('discreet mode masks every absolute amount on the portfolio surface and toggles back exactly', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const apiRequest = await newAdminRequestContext(newRequestContext);
  const user = await provisionUser(browser, apiRequest, 'discreet');
  await apiRequest.dispose();

  // Seed a real absolute amount on the default "Main" cash source, so at least
  // one MoneyText paints a euro figure the sweep can find (and later fail to
  // find). Driven with the exact labels cash-sources.spec.ts uses: the previous
  // fuzzy `Add cash movement|Add movement|Add cash` alternation matched NO
  // button this app has ever rendered, so this step could only ever time out —
  // the spec had never once reached its discreet-mode assertions. The sweep
  // stays on the accounts surface (below), so no holding is needed: the
  // redesigned Overview reports an empty portfolio when only cash exists.
  await user.page.goto('/portfolio/cash/accounts');
  await cashSourceAction(cashSourceRow(user.page, 0), 'Deposit').click();
  const depositDialog = user.page.getByRole('dialog', { name: 'Cash balance' });
  await depositDialog.getByLabel('Amount', { exact: true }).fill('1234.56');
  await depositDialog.getByRole('button', { name: 'Deposit cash' }).click();
  await expect(depositDialog).toBeHidden();

  // The swept surface is the Cash flow → accounts page, which is where the
  // seeded figure actually renders. `/portfolio` (Overview) reports "Your
  // portfolio is empty" for an account whose only value is cash, so it carries
  // no absolute amount to mask and can neither confirm nor refute the sweep.
  const SURFACE = '/portfolio/cash/accounts';
  // Locale-agnostic 2-dp: EN renders "1,234.56 €", DE "1.234,56 €".
  const SEEDED = /1[.,]234[.,]56/;

  // Sanity check: the € symbol and the exact amount render before discreet is on.
  await user.page.goto(SURFACE);
  await expect(user.page.locator('body')).toContainText('€', { timeout: 15_000 });
  await expect(user.page.locator('body')).toContainText(SEEDED);

  // Flip discreet mode ON from the profile menu (≤2 clicks per the anti-bloat
  // rule): open the account menu, toggle "Discreet mode".
  await flipDiscreetMode(user.page, true);

  // Sweep-style check: NO euro symbol and no trace of the seeded figure anywhere
  // on the surface, and the mask placeholder shows up in at least one place.
  await user.page.goto(SURFACE);
  await expect(user.page.locator('body')).not.toContainText('€', { timeout: 15_000 });
  await expect(user.page.locator('body')).not.toContainText(SEEDED);
  await expect(user.page.locator('body')).toContainText('•••');

  // Persists across a hard reload — the setting rides `/auth/me`.
  await user.page.reload();
  await expect(user.page.locator('body')).not.toContainText('€');

  // Toggle back OFF — the surface restores to the exact original amount.
  await flipDiscreetMode(user.page, false);
  await user.page.goto(SURFACE);
  await expect(user.page.locator('body')).toContainText('€', { timeout: 15_000 });
  await expect(user.page.locator('body')).toContainText(SEEDED);
  await expect(user.page.locator('body')).not.toContainText('•••');
});

/**
 * V5-P13 arc (a), second route set (#1757). The sweep above proves ONE surface;
 * §6.16 claims every surface, and the bell — which renders on every
 * authenticated route — used to print alert thresholds straight from the
 * server payload with the toggle on.
 *
 * A custom asset with a value point pins a deterministic 500 EUR quote, so the
 * asset detail page paints a real absolute amount, and a `price_above 100`
 * alert below it is guaranteed to fire on the next evaluator tick (the same
 * ≤90s expect-poll `alerts.spec.ts` uses — never a bare sleep). That fire lands
 * an inbox row whose body carries an amount the server composed into a
 * sentence, which is exactly the class of leak the seam cannot catch.
 */
test('discreet mode masks the asset detail page and the notification bell', async ({ browser }) => {
  test.setTimeout(300_000);

  const apiRequest = await newAdminRequestContext(newRequestContext);
  const user = await provisionUser(browser, apiRequest, 'discreetbell');
  await apiRequest.dispose();

  const page = user.page;
  const api = user.context.request;
  const symbol = `E2E Discreet ${Date.now().toString(36)}`;

  const createRes = await api.post(`${API_BASE_URL}/api/v1/custom-assets`, {
    headers: CSRF_HEADERS,
    data: { name: symbol, category: 'commodity', currency: 'EUR' },
  });
  expect(createRes.ok(), await createRes.text()).toBeTruthy();
  const assetId = ((await createRes.json()) as { asset: { id: string } }).asset.id;

  const today = new Date().toISOString().slice(0, 10);
  const pointsRes = await api.put(`${API_BASE_URL}/api/v1/custom-assets/${assetId}/value-points`, {
    headers: CSRF_HEADERS,
    data: { points: [{ date: today, value: 500 }] },
  });
  expect(pointsRes.ok(), await pointsRes.text()).toBeTruthy();

  const alertRes = await api.post(`${API_BASE_URL}/api/v1/alerts`, {
    headers: CSRF_HEADERS,
    data: { assetId, kind: 'price_above', threshold: 100, repeat: false },
  });
  expect(alertRes.ok(), await alertRes.text()).toBeTruthy();

  // ── Asset detail, discreet OFF: the pinned quote renders as real money.
  const DETAIL = `/assets/${assetId}`;
  await page.goto(DETAIL);
  await expect(page.locator('body')).toContainText('€', { timeout: 15_000 });
  await expect(page.locator('body')).toContainText(/500/);

  // ── The bell, discreet OFF: the fired alert names its threshold.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: /Notifications \(\d+ unread\)/ })).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 120_000, intervals: [3_000, 3_000, 5_000] });

  await page.getByRole('button', { name: /Notifications/ }).click();
  const bell = page.getByRole('group', { name: 'Notifications' });
  await expect(bell).toContainText(`${symbol} rose above 100 EUR.`, { timeout: 10_000 });
  await page.keyboard.press('Escape');

  // ── Toggle ON, then sweep both routes.
  await flipDiscreetMode(page, true);

  await page.goto(DETAIL);
  await expect(page.locator('body')).not.toContainText('€', { timeout: 15_000 });
  await expect(page.locator('body')).not.toContainText(/\b500\b/);
  await expect(page.locator('body')).toContainText('•••');

  await page.getByRole('button', { name: /Notifications/ }).click();
  const maskedBell = page.getByRole('group', { name: 'Notifications' });
  // The amount is gone; the asset, the denomination and the sentence remain.
  await expect(maskedBell).toContainText(`${symbol} rose above ••• EUR.`, { timeout: 10_000 });
  await expect(maskedBell).not.toContainText('100 EUR');

  // The bell is in the shell, so the same masked row must hold on another
  // route — this is the "every authenticated route" half of the claim.
  await page.keyboard.press('Escape');
  await page.goto('/portfolio/cash/accounts');
  await expect(page.locator('body')).not.toContainText('€', { timeout: 15_000 });
  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(page.getByRole('group', { name: 'Notifications' })).toContainText(
    `${symbol} rose above ••• EUR.`,
  );

  await user.context.close();
});

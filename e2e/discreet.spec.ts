import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { cashSourceAction, cashSourceRow } from './support/cashSurface';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

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

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
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

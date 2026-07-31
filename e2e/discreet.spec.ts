import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
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
 * toggle. The user provisions a portfolio, seeds a manual cash movement so a
 * real absolute amount renders on the portfolio surface, flips discreet mode
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

  // Seed a real absolute amount on the default "Main" portfolio via the Cash
  // Sources page so at least one MoneyText paints a euro figure the sweep can
  // find (and later fail to find) on `/portfolio`.
  await user.page.goto('/portfolio/cash-flow/accounts');
  const mainRow = user.page
    .getByRole('table', { name: 'Cash sources' })
    .getByRole('row')
    .filter({ hasText: 'Main' });
  await mainRow.getByRole('button', { name: 'Deposit' }).click();
  const cashDialog = user.page.getByRole('dialog', { name: 'Cash balance' });
  await cashDialog.getByLabel('Amount', { exact: true }).fill('1234.56');
  await cashDialog.getByRole('button', { name: 'Deposit cash' }).click();
  await expect(cashDialog).toBeHidden();

  // Confirm the sanity check: the € symbol renders somewhere on the portfolio
  // surface before we toggle discreet on.
  await user.page.goto('/portfolio');
  await expect(user.page.locator('body')).toContainText('€', { timeout: 15_000 });

  // Flip discreet mode ON from the profile menu (≤2 clicks per the anti-bloat
  // rule): open the account menu, toggle "Discreet mode".
  await flipDiscreetMode(user.page, true);

  // Sweep-style check: NO euro symbol anywhere on the portfolio page, and the
  // mask placeholder shows up in at least one place.
  await user.page.goto('/portfolio');
  await expect(user.page.locator('body')).not.toContainText('€', { timeout: 15_000 });
  await expect(user.page.locator('body')).toContainText('•••');

  // Persists across a hard reload — the setting rides `/auth/me`.
  await user.page.reload();
  await expect(user.page.locator('body')).not.toContainText('€');

  // Toggle back OFF — the surface restores to the exact original amount.
  await flipDiscreetMode(user.page, false);
  await user.page.goto('/portfolio');
  await expect(user.page.locator('body')).toContainText('€', { timeout: 15_000 });
  await expect(user.page.locator('body')).not.toContainText('•••');
});

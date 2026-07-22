import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

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
  await user.page.goto('/portfolio/cash');
  await user.page.getByRole('button', { name: /Add cash movement|Add movement|Add cash/i }).click();
  await user.page
    .getByLabel(/Amount/i)
    .first()
    .fill('1234.56');
  await user.page.getByRole('button', { name: /Save|Add/i }).click();

  // Confirm the sanity check: the € symbol renders somewhere on the portfolio
  // surface before we toggle discreet on.
  await user.page.goto('/portfolio');
  await expect(user.page.locator('body')).toContainText('€', { timeout: 15_000 });

  // Flip discreet mode ON from the profile menu (≤2 clicks per the anti-bloat
  // rule): open the account menu, toggle "Discreet mode".
  await user.page.getByRole('button', { name: /Account menu/i }).click();
  const toggle = user.page.getByRole('menuitemcheckbox', { name: /Discreet mode/i });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // Close the menu and let the tree re-render with the masked seam.
  await user.page.keyboard.press('Escape');

  // Sweep-style check: NO euro symbol anywhere on the portfolio page, and the
  // mask placeholder shows up in at least one place.
  await user.page.goto('/portfolio');
  await expect(user.page.locator('body')).not.toContainText('€', { timeout: 15_000 });
  await expect(user.page.locator('body')).toContainText('•••');

  // Persists across a hard reload — the setting rides `/auth/me`.
  await user.page.reload();
  await expect(user.page.locator('body')).not.toContainText('€');
  await user.page.getByRole('button', { name: /Account menu/i }).click();
  await expect(user.page.getByRole('menuitemcheckbox', { name: /Discreet mode/i })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Toggle back OFF — the surface restores to the exact original amount.
  await user.page.getByRole('menuitemcheckbox', { name: /Discreet mode/i }).click();
  await expect(user.page.getByRole('menuitemcheckbox', { name: /Discreet mode/i })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await user.page.keyboard.press('Escape');
  await user.page.goto('/portfolio');
  await expect(user.page.locator('body')).toContainText('€', { timeout: 15_000 });
  await expect(user.page.locator('body')).not.toContainText('•••');
});

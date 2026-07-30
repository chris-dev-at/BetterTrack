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

  // Seed a real absolute amount on the default "Main" cash source, so at least
  // one MoneyText paints a euro figure the sweep can find (and later fail to
  // find). Driven with the exact labels cash-sources.spec.ts uses: the previous
  // fuzzy `Add cash movement|Add movement|Add cash` alternation matched NO
  // button this app has ever rendered, so this step could only ever time out —
  // the spec had never once reached its discreet-mode assertions.
  await user.page.goto('/portfolio/cash-flow/accounts');
  const mainRow = user.page.locator('table[aria-label="Cash sources"] tbody tr').first();
  await mainRow.getByRole('button', { name: 'Deposit' }).click();
  const depositDialog = user.page.getByRole('dialog', { name: 'Cash balance' });
  await depositDialog.getByLabel('Amount', { exact: true }).fill('1234.56');
  await depositDialog.getByRole('button', { name: 'Deposit cash' }).click();
  await expect(depositDialog).toBeHidden();

  // The swept surface is the Cash flow → accounts page, which is where the
  // seeded figure actually renders. `/portfolio` (Overview) reports "Your
  // portfolio is empty" for an account whose only value is cash, so it carries
  // no absolute amount to mask and can neither confirm nor refute the sweep.
  const SURFACE = '/portfolio/cash-flow/accounts';
  // Locale-agnostic 2-dp: EN renders "1,234.56 €", DE "1.234,56 €".
  const SEEDED = /1[.,]234[.,]56/;

  // Sanity check: the € symbol and the exact amount render before discreet is on.
  await user.page.goto(SURFACE);
  await expect(user.page.locator('body')).toContainText('€', { timeout: 15_000 });
  await expect(user.page.locator('body')).toContainText(SEEDED);

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

  // Sweep-style check: NO euro symbol and no trace of the seeded figure anywhere
  // on the surface, and the mask placeholder shows up in at least one place.
  await user.page.goto(SURFACE);
  await expect(user.page.locator('body')).not.toContainText('€', { timeout: 15_000 });
  await expect(user.page.locator('body')).not.toContainText(SEEDED);
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
  await user.page.goto(SURFACE);
  await expect(user.page.locator('body')).toContainText('€', { timeout: 15_000 });
  await expect(user.page.locator('body')).toContainText(SEEDED);
  await expect(user.page.locator('body')).not.toContainText('•••');
});

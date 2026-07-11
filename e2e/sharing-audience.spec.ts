import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { befriend, provisionUser } from './support/users';

/**
 * V3-P5 sharing audiences (issue #426, flow 3). The owner sets a portfolio's
 * audience to ONE specific friend (the `specific_friends` tier has no friction
 * dialog). The enforcement must prove BOTH directions: the chosen friend sees
 * the share, a second friend who is NOT in the audience gets nothing.
 */
test('sharing audience: portfolio shared to one specific friend, hidden from another', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'shareowner');
  const chosen = await provisionUser(browser, apiRequest, 'chosenfriend');
  const excluded = await provisionUser(browser, apiRequest, 'excludedfriend');
  await apiRequest.dispose();

  // Both are friends of the owner — so the only variable is the audience choice.
  await befriend(owner, chosen);
  await befriend(owner, excluded);

  // Owner shares the default "Main" portfolio with the chosen friend only.
  await owner.page.goto('/social/my-shared');
  const portfolioRow = owner.page.getByRole('listitem').filter({ hasText: 'Main' });
  await portfolioRow.getByRole('button', { name: 'Share' }).click();

  const picker = owner.page.getByRole('dialog', { name: /Share/ });
  await expect(picker).toBeVisible();
  // Pick the "Specific friends" tier — no friction dialog for this tier.
  await picker.getByText('Specific friends', { exact: true }).click();
  await picker.getByText(chosen.username, { exact: true }).click();
  await expect(picker.getByText('1 selected')).toBeVisible();
  await picker.getByRole('button', { name: 'Save' }).click();
  await expect(picker).toBeHidden();

  // The chosen friend sees the shared portfolio in the owner's friend overview.
  await chosen.page.goto('/social/friends');
  await chosen.page.getByRole('button', { name: owner.username }).click();
  const sharedLink = chosen.page.getByRole('link', { name: /Main/ });
  await expect(sharedLink).toBeVisible({ timeout: 15_000 });
  await sharedLink.click();
  await expect(chosen.page.getByText(new RegExp(`shared by ${owner.username}`, 'i'))).toBeVisible({
    timeout: 15_000,
  });

  // The excluded friend — also a friend, but not in the audience — sees nothing.
  await excluded.page.goto('/social/friends');
  await excluded.page.getByRole('button', { name: owner.username }).click();
  await expect(
    excluded.page.getByText(new RegExp(`${owner.username} isn't sharing anything`, 'i')),
  ).toBeVisible({ timeout: 15_000 });
  await expect(excluded.page.getByRole('link', { name: /Main/ })).toHaveCount(0);

  await owner.context.close();
  await chosen.context.close();
  await excluded.context.close();
});

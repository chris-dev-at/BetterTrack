import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { befriend, provisionUser } from './support/users';

/**
 * Follows smoke (#438 person follows / #439 item follows, via issue #446). The
 * owner shares the default "Main" portfolio with one specific friend (the
 * sharing-audience pattern). That friend then follows the owner as a person
 * from the friend card, opens the shared portfolio and bookmarks it with the
 * item-follow button — and the Following page must list both: the person row
 * (with the per-person auto-follow switch) and the followed item, whose row
 * links back into the shared view.
 */
test('follows: follow a person and a shared portfolio, both listed on Following', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'followowner');
  const follower = await provisionUser(browser, apiRequest, 'follower');
  await apiRequest.dispose();

  await befriend(owner, follower);

  // Owner shares the default "Main" portfolio with the follower only
  // (sharing-audience.spec.ts pattern — the specific_friends tier has no
  // friction dialog).
  await owner.page.goto('/social/my-shared');
  const portfolioRow = owner.page.getByRole('listitem').filter({ hasText: 'Main' });
  await portfolioRow.getByRole('button', { name: 'Share' }).click();
  const picker = owner.page.getByRole('dialog', { name: /Share/ });
  await expect(picker).toBeVisible();
  await picker.getByText('Specific friends', { exact: true }).click();
  await picker.getByText(follower.username, { exact: true }).click();
  await expect(picker.getByText('1 selected')).toBeVisible();
  await picker.getByRole('button', { name: 'Save' }).click();
  await expect(picker).toBeHidden();

  // Follower expands the owner's friend card and follows the person — the
  // button flips from "Follow <user>" to "Following" (aria: "Unfollow <user>").
  await follower.page.goto('/social/friends');
  await follower.page.getByRole('button', { name: owner.username }).click();
  await follower.page.getByRole('button', { name: `Follow ${owner.username}` }).click();
  await expect(
    follower.page.getByRole('button', { name: `Unfollow ${owner.username}` }),
  ).toBeVisible({ timeout: 15_000 });

  // Open the shared portfolio from the same card and bookmark it (#439): the
  // item-follow button flips from "Follow this item" to "Unfollow this item".
  const sharedLink = follower.page.getByRole('link', { name: /Main/ });
  await expect(sharedLink).toBeVisible({ timeout: 15_000 });
  await sharedLink.click();
  await expect(follower.page.getByText(new RegExp(`shared by ${owner.username}`, 'i'))).toBeVisible(
    { timeout: 15_000 },
  );
  await follower.page.getByRole('button', { name: 'Follow this item' }).click();
  await expect(follower.page.getByRole('button', { name: 'Unfollow this item' })).toBeVisible({
    timeout: 15_000,
  });

  // The Following page lists the person (with the per-person auto-follow-items
  // switch, #439) and the followed item with its owner attribution.
  await follower.page.goto('/social/following');
  await expect(follower.page.getByText(`@${owner.username}`, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    follower.page.getByRole('switch', { name: `Auto-follow new items from ${owner.username}` }),
  ).toBeVisible();

  const itemRow = follower.page.getByRole('listitem').filter({ hasText: 'Main' });
  await expect(itemRow).toBeVisible({ timeout: 15_000 });
  await expect(itemRow).toContainText('Portfolio');
  await expect(itemRow).toContainText(`by @${owner.username}`);

  // The followed-item row links back into the friend-shared view.
  await itemRow.getByRole('link').click();
  await expect(follower.page.getByText(new RegExp(`shared by ${owner.username}`, 'i'))).toBeVisible(
    { timeout: 15_000 },
  );

  await owner.context.close();
  await follower.context.close();
});

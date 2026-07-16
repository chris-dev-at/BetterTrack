import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { befriend, provisionUser } from './support/users';

/**
 * Follows smoke (#438 person follows / #439 item follows), reworked for the V4
 * Social rework (#532): the standalone Following page is retired and the
 * aggregated Followed-items list is gone, so following lives entirely in the
 * Friends tab as notification subscriptions. The owner shares the default "Main"
 * portfolio with one specific friend. That friend follows the owner as a person
 * straight from the friend-card expansion (no public profile needed), sees the
 * per-person auto-follow switch there, opens the shared portfolio and bookmarks
 * it (the item-follow toggle round-trips). When the owner opts into alert
 * sharing — now from the Social "My items" area, not Settings — a single
 * "Follow their alerts" toggle appears in the same row expansion; and the
 * retired `/social/following` path redirects to the Friends tab.
 */
test('follows: follow + bookmark from the Friends tab, alert toggle, /following redirect', async ({
  browser,
}) => {
  // The spec walks through two provisioned accounts and six /social navigations —
  // 180 s ran out in the nightly on slow steps (#521), so match happy-path's budget.
  test.setTimeout(240_000);

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

  // Follower expands the owner's friend card and follows the person straight
  // from the row (V4-P0b — a friend needs no public profile). The button flips
  // from "Follow <user>" to "Following" (aria: "Unfollow <user>"), and the
  // per-person auto-follow switch (#439) appears in the same expansion.
  await follower.page.goto('/social/friends');
  await follower.page.getByRole('button', { name: owner.username }).click();
  await follower.page.getByRole('button', { name: `Follow ${owner.username}` }).click();
  await expect(
    follower.page.getByRole('button', { name: `Unfollow ${owner.username}` }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    follower.page.getByRole('switch', { name: `Auto-follow new items from ${owner.username}` }),
  ).toBeVisible();

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

  // The aggregated Followed-items list was removed (#532): the Friends tab no
  // longer surfaces a followed-items collection.
  await follower.page.goto('/social/friends');
  await expect(follower.page.getByText('Followed items')).toBeHidden();

  // ── Alert follows (#455) ──────────────────────────────────────────────────
  // The owner opts in to sharing their alerts with followers — the control now
  // lives in the Social "My items" area (#532) and raises the all-followers
  // friction dialog first.
  await owner.page.goto('/social/my-shared');
  const shareToggle = owner.page.getByRole('switch', { name: 'Share my alerts with followers' });
  await expect(shareToggle).toHaveAttribute('aria-checked', 'false');
  await shareToggle.click();
  await owner.page.getByRole('button', { name: 'I understand — share my alerts' }).click();
  await expect(shareToggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });

  // The follower's friend-row expansion now carries a single "Follow their
  // alerts" toggle — it renders ONLY while the owner shares their alerts (#532).
  // It defaults OFF; flipping it on persists across a reload.
  await follower.page.goto('/social/friends');
  await follower.page.getByRole('button', { name: owner.username }).click();
  const alertToggle = follower.page.getByRole('switch', {
    name: `Follow alerts from ${owner.username}`,
  });
  await expect(alertToggle).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await alertToggle.click();
  await expect(alertToggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
  await follower.page.reload();
  await follower.page.getByRole('button', { name: owner.username }).click();
  await expect(
    follower.page.getByRole('switch', {
      name: `Follow alerts from ${owner.username}`,
    }),
  ).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });

  // The retired Following page redirects to the Friends tab.
  await follower.page.goto('/social/following');
  await expect(follower.page).toHaveURL(/\/social\/friends$/);

  await owner.context.close();
  await follower.context.close();
});

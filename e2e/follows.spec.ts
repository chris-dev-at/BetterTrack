import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { befriend, provisionUser } from './support/users';

/**
 * Follows smoke (#438 person follows / #439 item follows), reworked for V4-P0b:
 * the standalone Following page is retired, so following now lives entirely in
 * the Friends tab. The owner shares the default "Main" portfolio with one
 * specific friend. That friend follows the owner as a person straight from the
 * friend-card expansion (no public profile needed), sees the per-person
 * auto-follow switch there, opens the shared portfolio and bookmarks it — and
 * the Friends tab lists the bookmark, whose row links back into the shared view.
 * When the owner opts into alert sharing (from its new Settings home), the
 * alert-follow switches appear in the same row expansion; and the retired
 * `/social/following` path redirects to the Friends tab.
 */
test('follows: follow + bookmark from the Friends tab, alert switches, /following redirect', async ({
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

  // The Friends tab now hosts the followed-items collection: the bookmark shows
  // with its owner attribution and links back into the friend-shared view.
  await follower.page.goto('/social/friends');
  const itemRow = follower.page.getByRole('listitem').filter({ hasText: 'Main' });
  await expect(itemRow).toBeVisible({ timeout: 15_000 });
  await expect(itemRow).toContainText('Portfolio');
  await expect(itemRow).toContainText(`by @${owner.username}`);
  await itemRow.getByRole('link').click();
  await expect(follower.page.getByText(new RegExp(`shared by ${owner.username}`, 'i'))).toBeVisible(
    { timeout: 15_000 },
  );

  // ── Alert follows (#455) ──────────────────────────────────────────────────
  // The owner opts in to sharing their alerts with followers — the control now
  // lives under Settings → Notifications (V4-P0b relocation) and raises the
  // all-followers friction dialog first.
  await owner.page.goto('/settings/notifications');
  const shareToggle = owner.page.getByRole('switch', { name: 'Share my alerts with followers' });
  await expect(shareToggle).toHaveAttribute('aria-checked', 'false');
  await shareToggle.click();
  await owner.page.getByRole('button', { name: 'I understand — share my alerts' }).click();
  await expect(shareToggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });

  // The follower's friend-row expansion now carries the two independent alert
  // triggers (created / fired) — they render ONLY while the owner shares their
  // alerts (V4-P0b). Both default OFF; flipping one persists across a reload.
  await follower.page.goto('/social/friends');
  await follower.page.getByRole('button', { name: owner.username }).click();
  const createTrigger = follower.page.getByRole('switch', {
    name: `Notify me about new alerts from ${owner.username}`,
  });
  const fireTrigger = follower.page.getByRole('switch', {
    name: `Notify me when alerts from ${owner.username} fire`,
  });
  await expect(createTrigger).toHaveAttribute('aria-checked', 'false', { timeout: 15_000 });
  await expect(fireTrigger).toHaveAttribute('aria-checked', 'false');
  await createTrigger.click();
  await expect(createTrigger).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
  await follower.page.reload();
  await follower.page.getByRole('button', { name: owner.username }).click();
  await expect(
    follower.page.getByRole('switch', {
      name: `Notify me about new alerts from ${owner.username}`,
    }),
  ).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });

  // The retired Following page redirects to the Friends tab.
  await follower.page.goto('/social/following');
  await expect(follower.page).toHaveURL(/\/social\/friends$/);

  await owner.context.close();
  await follower.context.close();
});

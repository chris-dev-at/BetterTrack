import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { befriend, provisionUser } from './support/users';

/**
 * V5-P8 friend groups as a sharing audience (issue #626, area 3). The owner
 * builds a named group, adds ONE of two friends to it, then shares the default
 * "Main" portfolio to the `group` audience. Enforcement must hold in BOTH
 * directions: the group member sees the share, the equally-befriended
 * non-member sees nothing — the only variable is group membership.
 *
 * Everything is driven through the real UI (Friends → Groups, the audience
 * picker's `group` tier, the friend overview) so the group→audience wiring is
 * exercised end-to-end, mirroring `sharing-audience.spec.ts`.
 */
test('friend groups: a portfolio shared to a group is visible to members only', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'groupowner');
  const member = await provisionUser(browser, apiRequest, 'groupmember');
  const outsider = await provisionUser(browser, apiRequest, 'groupoutsider');
  await apiRequest.dispose();

  // Both are friends of the owner — so group membership is the only variable.
  await befriend(owner, member);
  await befriend(owner, outsider);

  // Owner creates a group and adds only `member` to it.
  await owner.page.goto('/social/friends');
  await owner.page.getByLabel('New group name').fill('Inner Circle');
  await owner.page.getByRole('button', { name: 'Create' }).click();

  // Expand the freshly-created group card, then add `member` from the candidates.
  await owner.page.getByRole('button', { name: 'Inner Circle' }).click();
  const memberCandidate = owner.page
    .getByRole('listitem')
    .filter({ hasText: member.username })
    .filter({ has: owner.page.getByRole('button', { name: 'Add', exact: true }) });
  await expect(memberCandidate).toBeVisible({ timeout: 15_000 });
  await memberCandidate.getByRole('button', { name: 'Add', exact: true }).click();
  // Once added, `member` moves out of the candidate list (Add gone for that row).
  await expect(memberCandidate).toBeHidden();

  // Owner shares "Main" to the group audience.
  await owner.page.goto('/social/my-shared');
  const portfolioRow = owner.page.getByRole('listitem').filter({ hasText: 'Main' });
  await portfolioRow.getByRole('button', { name: 'Share' }).click();

  const picker = owner.page.getByRole('dialog', { name: /Share/ });
  await expect(picker).toBeVisible();
  await picker.getByText('Friend group', { exact: true }).click();
  await picker.getByText('Inner Circle', { exact: true }).click();
  await picker.getByRole('button', { name: 'Save' }).click();
  await expect(picker).toBeHidden();

  // The group member sees the shared portfolio in the owner's friend overview.
  await member.page.goto('/social/friends');
  await member.page.getByRole('button', { name: owner.username }).click();
  const sharedLink = member.page.getByRole('link', { name: /Main/ });
  await expect(sharedLink).toBeVisible({ timeout: 15_000 });
  await sharedLink.click();
  await expect(member.page.getByText(new RegExp(`shared by ${owner.username}`, 'i'))).toBeVisible({
    timeout: 15_000,
  });

  // The non-member — a friend, but not in the group — sees nothing.
  await outsider.page.goto('/social/friends');
  await outsider.page.getByRole('button', { name: owner.username }).click();
  await expect(
    outsider.page.getByText(new RegExp(`${owner.username} isn't sharing anything`, 'i')),
  ).toBeVisible({ timeout: 15_000 });
  await expect(outsider.page.getByRole('link', { name: /Main/ })).toHaveCount(0);

  await owner.context.close();
  await member.context.close();
  await outsider.context.close();
});

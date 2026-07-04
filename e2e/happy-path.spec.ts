import { expect, request as newRequestContext, test } from '@playwright/test';

import { createInvite, loginAsAdmin } from './support/adminApi';
import { ACCOUNT_PASSWORD, API_BASE_URL } from './support/config';
import { acceptInvite, watchAsset } from './support/flows';

/**
 * PROJECTPLAN §12 thin e2e happy path (nightly, not per-commit): invite/login
 * → local search → watch → build conglomerate → allocate → add to portfolio
 * → enable friend sharing → a second account accepts the request and sees
 * the shared portfolio.
 */
test('happy path: invite through friend sharing', async ({ browser }) => {
  test.setTimeout(180_000);

  const runId = Date.now();
  const ownerEmail = `e2e-owner-${runId}@bettertrack.local`;
  const friendEmail = `e2e-friend-${runId}@bettertrack.local`;
  const ownerUsername = `e2eowner${runId}`.slice(0, 40);
  const friendUsername = `e2efriend${runId}`.slice(0, 40);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const ownerToken = await createInvite(apiRequest, ownerEmail);
  const friendToken = await createInvite(apiRequest, friendEmail);
  await apiRequest.dispose();

  const ownerContext = await browser.newContext();
  const friendContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const friend = await friendContext.newPage();

  await acceptInvite(owner, ownerToken, ownerUsername, ACCOUNT_PASSWORD);
  await acceptInvite(friend, friendToken, friendUsername, ACCOUNT_PASSWORD);

  // search (local) → watch
  await watchAsset(owner, 'Apple', 'AAPL');

  // build conglomerate
  await owner.goto('/workboard/conglomerates/new');
  await owner.getByLabel('Conglomerate name').fill('E2E Basket');
  const builderSearch = owner.getByRole('searchbox', { name: 'Search assets' });
  await builderSearch.fill('Apple');
  await owner.getByRole('button', { name: 'Select AAPL' }).click();
  await builderSearch.fill('Microsoft');
  await owner.getByRole('button', { name: 'Select MSFT' }).click();
  await owner.getByRole('button', { name: 'Auto-balance' }).click();
  const positionsRegion = owner.getByRole('region', { name: 'Positions' });
  await expect(positionsRegion.getByRole('status')).toHaveText('100.0%');
  await owner.getByRole('button', { name: 'Activate' }).click();
  await expect(owner).toHaveURL(/\/workboard\/conglomerates\/[^/]+$/, { timeout: 20_000 });

  // allocate → buy list (the deviation table has a "Cost" column the
  // always-present Positions table does not, so this only passes once the
  // buy list itself has rendered)
  await owner.getByRole('button', { name: 'Calculate' }).click();
  await expect(owner.getByRole('columnheader', { name: 'Cost' })).toBeVisible({ timeout: 30_000 });

  // add to portfolio
  await owner.getByRole('button', { name: 'Add to Portfolio' }).click();
  const transactionDialog = owner.getByRole('dialog', { name: /record transaction/i });
  await expect(transactionDialog).toBeVisible();
  await transactionDialog.getByRole('button', { name: 'Record' }).click();
  await expect(transactionDialog).toBeHidden();

  await owner.goto('/portfolio');
  const ownerHoldings = owner.getByRole('region', { name: 'Holdings' });
  await expect(ownerHoldings.getByRole('link', { name: 'AAPL' })).toBeVisible({
    timeout: 15_000,
  });

  // enable friend sharing on the (default "Main") portfolio
  await owner.goto('/settings/account');
  await owner.getByRole('radio', { name: 'Yes' }).click();
  await expect(owner.getByRole('radio', { name: 'Yes' })).toHaveAttribute('aria-checked', 'true');

  // owner sends the friend request
  await owner.goto('/social/friends');
  await owner.getByLabel('Username or email').fill(friendUsername);
  await owner.getByRole('button', { name: 'Send request' }).click();
  await expect(owner.getByText(/we've sent your friend request/i)).toBeVisible();

  // second account accepts the request and sees the shared portfolio
  await friend.goto('/social/friends');
  await expect(friend.getByText(ownerUsername)).toBeVisible({ timeout: 15_000 });
  await friend.getByRole('button', { name: 'Accept' }).click();

  await friend.goto('/social/shared-with-me');
  const sharedLink = friend.getByRole('link', { name: 'Main' });
  await expect(sharedLink).toBeVisible({ timeout: 15_000 });
  await expect(friend.getByText(ownerUsername)).toBeVisible();
  await sharedLink.click();

  await expect(friend.getByText(new RegExp(`shared by ${ownerUsername}`, 'i'))).toBeVisible();
  const friendHoldings = friend.getByRole('region', { name: 'Holdings' });
  await expect(friendHoldings.getByRole('link', { name: 'AAPL' })).toBeVisible({
    timeout: 15_000,
  });
});

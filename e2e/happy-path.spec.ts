import { expect, request as newRequestContext, test } from '@playwright/test';

import { createInvite, loginAsAdmin } from './support/adminApi';
import { ACCOUNT_PASSWORD, API_BASE_URL } from './support/config';
import { acceptInvite, openAssetAndWatchFromDetail, watchAsset } from './support/flows';

/**
 * PROJECTPLAN §12 thin e2e happy path (nightly, not per-commit): invite/login
 * → local search → watch → build conglomerate → allocate → add to portfolio
 * → enable friend sharing → a second account accepts the request and sees
 * the shared portfolio — extended with the new V2 flows (§13.2 V2-P11): a
 * 1-char search watched from the asset detail page, a cash-funded buy, a
 * second portfolio, and friend-shared watchlist.
 */
test('happy path: invite through friend sharing', async ({ browser }) => {
  test.setTimeout(240_000);

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

  // V2-P11: a 1-char ticker search, watched from the asset detail page's icon
  // button, must show up on the watchlist page via SPA navigation (no reload).
  await openAssetAndWatchFromDetail(owner, 'V', 'V');
  const primaryNav = owner.getByRole('navigation', { name: 'Primary' });
  await primaryNav.getByRole('link', { name: 'Workboard' }).click();
  await expect(owner).toHaveURL(/\/workboard$/);
  const watchlistTable = owner.getByRole('table');
  await expect(watchlistTable.getByRole('link', { name: 'V' })).toBeVisible({ timeout: 15_000 });

  // build conglomerate
  await owner.goto('/workboard/conglomerates/new');
  await owner.getByLabel('Conglomerate name').fill('E2E Basket');
  const builderSearch = owner.getByRole('searchbox', { name: 'Search assets' });
  // exact: role-name matching is substring-based, and background catalog
  // enrichment can add sibling listings (AAPL.SW, MSFT.MX, …) to the results.
  await builderSearch.fill('Apple');
  await owner.getByRole('button', { name: 'Select AAPL', exact: true }).click();
  await builderSearch.fill('Microsoft');
  await owner.getByRole('button', { name: 'Select MSFT', exact: true }).click();
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

  // V2-P11: deposit cash, then buy an EUR-native asset (SAP, no FX conversion)
  // paid from the cash balance — the cash-after preview shown before Record,
  // and the overview cash line reconciling to deposit minus cost afterward.
  await owner.getByRole('button', { name: '+ Deposit' }).click();
  const cashDialog = owner.getByRole('dialog', { name: 'Cash balance' });
  await cashDialog.getByLabel('Amount').fill('800');
  await cashDialog.getByRole('button', { name: 'Deposit cash' }).click();
  await expect(cashDialog).toBeHidden();

  await owner.getByRole('button', { name: '+ Transaction' }).click();
  const buyDialog = owner.getByRole('dialog', { name: /record transaction/i });
  await buyDialog.getByRole('searchbox', { name: 'Search assets' }).fill('SAP');
  await buyDialog.getByRole('button', { name: 'Select SAP.DE', exact: true }).click();
  await buyDialog.getByLabel('Quantity for SAP.DE').fill('4');
  await buyDialog.getByLabel('Price for SAP.DE').fill('50');
  await buyDialog.getByLabel('Pay from cash balance').check();
  await expect(buyDialog.getByRole('status', { name: 'Cash-after preview' })).toContainText('→', {
    timeout: 15_000,
  });
  await buyDialog.getByRole('button', { name: 'Record' }).click();
  await expect(buyDialog).toBeHidden();

  await owner.goto('/portfolio');
  const cashLabel = owner
    .getByRole('region', { name: 'Portfolio totals' })
    .getByText('Cash', { exact: true });
  await expect(cashLabel.locator('xpath=following-sibling::p[1]')).toContainText('600,00', {
    timeout: 15_000,
  });

  // V2-P11: create and switch to a second portfolio — scoped views (holdings)
  // follow the active portfolio, then switch back to the default.
  const switcher = owner.getByRole('button', { name: 'Switch portfolio' });
  await switcher.click();
  await owner.getByRole('menuitem', { name: '+ New portfolio' }).click();
  const newPortfolioDialog = owner.getByRole('dialog', { name: 'New portfolio' });
  await newPortfolioDialog.getByLabel('Portfolio name').fill('Growth');
  await newPortfolioDialog.getByRole('button', { name: 'Create' }).click();
  await expect(newPortfolioDialog).toBeHidden();
  await expect(switcher).toContainText('Growth');
  await expect(owner.getByText('Your portfolio is empty')).toBeVisible({ timeout: 15_000 });

  await switcher.click();
  await owner.getByRole('menuitemradio', { name: 'Main' }).click();
  await expect(switcher).toContainText('Main');
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

  // V2-P11: owner shares the watchlist to friends; the already-accepted friend
  // sees it read-only under Shared With Me.
  await owner.goto('/workboard');
  await owner.getByRole('button', { name: 'Share with friends' }).click();
  await expect(owner.getByRole('button', { name: 'Shared with friends' })).toBeVisible();

  await friend.goto('/social/shared-with-me');
  const watchlistLink = friend.getByRole('link', {
    name: new RegExp(`${ownerUsername}.s watchlist`),
  });
  await expect(watchlistLink).toBeVisible({ timeout: 15_000 });
  await watchlistLink.click();

  await expect(
    friend.getByRole('heading', { name: new RegExp(`${ownerUsername}.s watchlist`) }),
  ).toBeVisible();
  await expect(friend.getByText('AAPL')).toBeVisible();
  await expect(friend.getByText('V', { exact: true })).toBeVisible();
});

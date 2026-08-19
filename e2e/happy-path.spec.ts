import { expect, request as newRequestContext, test } from '@playwright/test';

import { createInvite, newAdminRequestContext } from './support/adminApi';
import { setWideningAudienceThroughLadder } from './support/audience';
import { ACCOUNT_PASSWORD } from './support/config';
import { recentOpenBookingDates } from './support/dates';
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

  const apiRequest = await newAdminRequestContext(newRequestContext);
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
  await primaryNav.getByRole('link', { name: 'Workbench' }).click();
  await expect(owner).toHaveURL(/\/workbench$/);
  const watchlistTable = owner.getByRole('table');
  await expect(watchlistTable.getByRole('link', { name: 'V' })).toBeVisible({ timeout: 15_000 });

  // build conglomerate
  await owner.goto('/workbench/blueprints/new');
  await owner.getByLabel('Blueprint name').fill('E2E Basket');
  const builderSearch = owner.getByRole('searchbox', { name: 'Search assets' });
  // exact: role-name matching is substring-based, and background catalog
  // enrichment can add sibling listings (AAPL.SW, MSFT.MX, …) to the results.
  await builderSearch.fill('Apple');
  await owner.getByRole('button', { name: 'Select AAPL', exact: true }).click();
  await builderSearch.fill('Microsoft');
  await owner.getByRole('button', { name: 'Select MSFT', exact: true }).click();
  await owner.getByRole('button', { name: 'Auto-balance' }).click();
  const positionsRegion = owner.getByRole('region', { name: 'Positions' });
  // Locale-agnostic 2-dp: EN "100.00%" (en-GB) vs DE "100,00 %" (de-AT with narrow space).
  await expect(positionsRegion.getByRole('status')).toHaveText(/^100[.,]00\s*%$/);
  await owner.getByRole('button', { name: 'Activate' }).click();
  await expect(owner).toHaveURL(/\/workbench\/blueprints\/[^/]+$/, { timeout: 20_000 });

  // allocate → buy list (the deviation table has a "Cost" column the
  // always-present Positions table does not, so this only passes once the
  // buy list itself has rendered)
  await owner.getByRole('button', { name: 'Calculate' }).click();
  await expect(owner.getByRole('columnheader', { name: 'Cost' })).toBeVisible({ timeout: 30_000 });

  // add to portfolio
  await owner.getByRole('button', { name: 'Add to Portfolio' }).click();
  const transactionDialog = owner.getByRole('dialog', { name: /new transaction/i });
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

  const [sapTradeDate] = await recentOpenBookingDates(owner, 1);
  await owner.getByRole('button', { name: '+ Transaction' }).click();
  const buyDialog = owner.getByRole('dialog', { name: /new transaction/i });
  await buyDialog.getByRole('searchbox', { name: 'Search assets' }).fill('SAP');
  await buyDialog.getByRole('button', { name: 'Select SAP.DE', exact: true }).click();
  // The historical-price assist can map the round €50 input back to a closed
  // tax year. This cash-flow test needs a deliberately open recent booking day,
  // so make both fields manual before entering the fixture price.
  const unlinkDateAndPrice = buyDialog.getByRole('button', { name: 'Unlink date and price' });
  await unlinkDateAndPrice.waitFor({ state: 'visible', timeout: 20_000 });
  await unlinkDateAndPrice.click();
  await buyDialog.getByLabel('Date for SAP.DE').fill(sapTradeDate!);
  await buyDialog.getByLabel('Quantity for SAP.DE').fill('4');
  await buyDialog.getByLabel('Price for SAP.DE').fill('50');
  await expect(buyDialog.getByLabel('Date for SAP.DE')).toHaveValue(sapTradeDate!);
  // Keyboard toggle + checked assertion (main's #1019 hardening) — .check()
  // proved unreliable against the styled control. The preview assertion states
  // the resulting balance: 800 deposited − 4 × 50 = 600, the property the
  // preview exists for. Locale-agnostic: EN "600.00" vs DE "600,00".
  const payFromCash = buyDialog.getByLabel('Pay from cash balance');
  await payFromCash.press('Space');
  await expect(payFromCash).toBeChecked();
  await expect(buyDialog.getByRole('status', { name: 'Cash-after preview' })).toContainText(
    /600[.,]00/,
    { timeout: 15_000 },
  );
  await buyDialog.getByRole('button', { name: 'Record' }).click();
  await expect(buyDialog).toBeHidden();

  await owner.goto('/portfolio');
  // Locale-agnostic: EN "600.00" (en-GB) vs DE "600,00" (de-AT).
  const totals = owner.getByRole('region', { name: 'Portfolio totals' });
  const cashLabel = totals.locator('.bt-stat__label').filter({ hasText: 'Cash' });
  await expect(cashLabel).toHaveText('Cash');
  const cashValue = cashLabel.locator(
    'xpath=following-sibling::*[contains(@class, "bt-stat__value")]',
  );
  await expect(cashValue).toHaveText(/600[.,]00/, {
    timeout: 15_000,
  });

  // V2-P11: create and switch to a second portfolio — scoped views (holdings)
  // follow the active portfolio, then switch back to the default.
  const switcher = owner.getByRole('button', { name: 'Switch portfolio' });
  // A filterable picker, so a labelled disclosure group rather than an ARIA
  // menu (#977): its rows and actions are ordinary buttons and links.
  const switcherPopover = owner.getByRole('group', { name: 'Portfolios' });
  await switcher.click();
  // The switcher's single create entry point is the add-portfolio wizard:
  // name, icon and who keeps the book on ONE panel, one press (2026-07-31).
  await switcherPopover.getByRole('button', { name: 'Add portfolio' }).click();
  const wizard = owner.getByRole('dialog', { name: 'Add portfolio' });
  await wizard.getByLabel('Portfolio name').fill('Growth');
  await wizard.getByRole('radio', { name: 'Savings' }).click();
  await wizard.getByRole('radio', { name: /Just me/ }).click();
  await wizard.getByRole('button', { name: 'Create portfolio' }).click();
  // Created: the wizard hands the portfolio to the switcher and gets out.
  await expect(wizard).toBeHidden();
  await expect(switcher).toContainText('Growth');
  // The icon picked in the wizard is the one the trigger now carries.
  await expect(switcher.locator('svg[data-icon="piggy-bank"]')).toBeVisible();
  await expect(owner.getByText('Your portfolio is empty')).toBeVisible({ timeout: 15_000 });

  await switcher.click();
  await switcherPopover.getByRole('button', { name: 'Main' }).click();
  await expect(switcher).toContainText('Main');
  await expect(ownerHoldings.getByRole('link', { name: 'AAPL' })).toBeVisible({
    timeout: 15_000,
  });

  // Enable friend sharing on the (default "Main") portfolio. V3-P5/#377 retired
  // the Settings visibility toggle; ALL sharing now lives on /social/my-shared
  // and flows through the AudiencePicker. Share to "all_friends" so anyone who
  // later becomes a friend of the owner inherits access via the audience model.
  await owner.goto('/people/shared');
  const mainRow = owner.getByRole('listitem').filter({ hasText: 'Main' });
  await mainRow.getByRole('button', { name: 'Share' }).click();
  const audiencePicker = owner.getByRole('dialog', { name: /Share/ });
  await expect(audiencePicker).toBeVisible();
  await setWideningAudienceThroughLadder(audiencePicker, { audience: 'all_friends' });
  await expect(audiencePicker).toBeHidden();

  // owner sends the friend request
  await owner.goto('/people');
  await owner.getByLabel('Username or email').fill(friendUsername);
  await owner.getByRole('button', { name: 'Send request' }).click();
  await expect(owner.getByText(/we've sent your friend request/i)).toBeVisible();

  // second account accepts the request and sees the shared portfolio via the
  // friend card's expansion (V4-P0b — the standalone Shared-With-Me tab is
  // retired; per-friend shares live inside the friend row).
  await friend.goto('/people');
  await expect(friend.getByText(ownerUsername)).toBeVisible({ timeout: 15_000 });
  await friend.getByRole('button', { name: 'Accept' }).click();

  const friendCard = friend.getByRole('button', { name: ownerUsername });
  await expect(friendCard).toBeVisible({ timeout: 15_000 });
  await friendCard.click();

  // Anchored: role-name matching is substring by default, and the shell's
  // "Skip to main content" link would otherwise match 'Main' too. The shared
  // link's accessible name is "Main <balance>", so anchor on the word.
  const sharedLink = friend.getByRole('link', { name: /^Main\b/ });
  await expect(sharedLink).toBeVisible({ timeout: 15_000 });
  await sharedLink.click();

  await expect(friend.getByText(new RegExp(`shared by ${ownerUsername}`, 'i'))).toBeVisible();
  const friendHoldings = friend.getByRole('region', { name: 'Holdings' });
  await expect(friendHoldings.getByRole('link', { name: 'AAPL' })).toBeVisible({
    timeout: 15_000,
  });

  // V2-P11: owner shares the watchlist to friends; the already-accepted friend
  // sees the "General" watchlist read-only inside the same friend-card row.
  await owner.goto('/workbench');
  await owner.getByRole('button', { name: 'Share with friends' }).click();
  const watchlistPicker = owner.getByRole('dialog', { name: /Share/ });
  await expect(watchlistPicker).toBeVisible();
  await setWideningAudienceThroughLadder(watchlistPicker, { audience: 'all_friends' });
  await expect(watchlistPicker).toBeHidden();
  await expect(owner.getByRole('button', { name: 'Shared with friends' })).toBeVisible();

  await friend.goto('/people');
  const friendCardAgain = friend.getByRole('button', { name: ownerUsername });
  await expect(friendCardAgain).toBeVisible({ timeout: 15_000 });
  await friendCardAgain.click();
  const watchlistLink = friend.getByRole('link', { name: 'General' });
  await expect(watchlistLink).toBeVisible({ timeout: 15_000 });
  await watchlistLink.click();

  // SharedWatchlistPage heading is `${owner}'s ${watchlistName}` — the default
  // watchlist is "General", so the composed heading is "ownerusername's General".
  await expect(
    friend.getByRole('heading', { name: new RegExp(`${ownerUsername}.s General`) }),
  ).toBeVisible();
  await expect(friend.getByText('AAPL')).toBeVisible();
  await expect(friend.getByText('V', { exact: true })).toBeVisible();
});

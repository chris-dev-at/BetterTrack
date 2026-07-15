import { expect, type Page } from '@playwright/test';

/** Drives the real /invite/:token page to provision a brand-new account. */
export async function acceptInvite(
  page: Page,
  token: string,
  username: string,
  password: string,
): Promise<void> {
  await page.goto(`/invite/${token}`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/portfolio$/, { timeout: 20_000 });
}

/** Searches the local catalog and watches the first matching asset's symbol from the results row. */
export async function watchAsset(page: Page, query: string, symbol: string): Promise<void> {
  await page.goto('/assets/search');
  await page.getByRole('searchbox', { name: 'Search assets' }).fill(query);
  const watchButton = page.getByRole('button', { name: `Add ${symbol} to watchlist` });
  await expect(watchButton).toBeVisible({ timeout: 15_000 });
  await watchButton.click();
  await expect(page.getByRole('button', { name: `${symbol} is on your watchlist` })).toBeVisible();
}

/**
 * Search-and-watchlist flow driven from the asset detail page's icon button
 * (§13.2) instead of the search-results row — exercises `WatchlistIconButton`
 * rather than `WatchlistControl`.
 */
export async function openAssetAndWatchFromDetail(
  page: Page,
  query: string,
  symbol: string,
): Promise<void> {
  await page.goto('/assets/search');
  await page.getByRole('searchbox', { name: 'Search assets' }).fill(query);
  const openButton = page.getByRole('button', { name: new RegExp(`^Open ${symbol} —`) });
  await expect(openButton).toBeVisible({ timeout: 15_000 });
  await openButton.click();
  await expect(page).toHaveURL(/\/assets\/[^/]+$/);
  await page.getByRole('button', { name: `Add ${symbol} to watchlist` }).click();
  await expect(page.getByRole('button', { name: `${symbol} is on your watchlist` })).toBeVisible();
}

export interface SapTrade {
  side: 'buy' | 'sell';
  quantity: string;
  price: string;
  /** ISO `YYYY-MM-DD`; distinct dates make the realized-P/L ordering unambiguous. */
  date: string;
}

/**
 * Record one SAP.DE trade through the real "+ Transaction" dialog. The date↔price
 * assist is unlinked first so the entered price/date are taken verbatim — the
 * assist would otherwise refill the price from market history. The toggle exists
 * only once a price series is available, so a failure to find it is ignored (no
 * series ⇒ no assist ⇒ nothing to unlink).
 */
export async function recordSapTrade(page: Page, trade: SapTrade): Promise<void> {
  await page.goto('/portfolio');
  await page.getByRole('button', { name: '+ Transaction' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search assets' }).fill('SAP');
  await dialog.getByRole('button', { name: 'Select SAP.DE', exact: true }).click();

  await dialog
    .getByRole('button', { name: 'Unlink date and price' })
    .click({ timeout: 20_000 })
    .catch(() => {});

  if (trade.side === 'sell') await dialog.getByRole('button', { name: 'Sell' }).click();
  await dialog.getByLabel('Date for SAP.DE').fill(trade.date);
  await dialog.getByLabel('Quantity for SAP.DE').fill(trade.quantity);
  // Price last: even if the assist is still linked, a manual price wins and a
  // round value never matches an exact historical close, so the date is left be.
  await dialog.getByLabel('Price for SAP.DE').fill(trade.price);
  await dialog
    .getByRole('button', { name: trade.side === 'sell' ? 'Record sell' : 'Record buy' })
    .click();
  await expect(dialog).toBeHidden();
}

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

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

/**
 * Build and activate a Conglomerate through the real Builder (§13.4 V4-P7/P9
 * e2e helper). Picks each asset by exact symbol via the local search box, then
 * Auto-balances to the ACTIVE_SUM (§6.5) and clicks Activate. Returns the
 * post-activation detail URL (`/workboard/conglomerates/:id`) so callers can
 * come back to it after side trips (creating another conglomerate, listing).
 */
export async function activateConglomerate(
  page: Page,
  name: string,
  picks: ReadonlyArray<{ query: string; symbol: string }>,
): Promise<string> {
  await page.goto('/workboard/conglomerates/new');
  await page.getByLabel('Conglomerate name').fill(name);
  const search = page.getByRole('searchbox', { name: 'Search assets' });
  for (const p of picks) {
    // exact: role-name matching is substring-based, and background enrichment
    // can pull sibling listings into the results (mirrors happy-path.spec.ts).
    await search.fill(p.query);
    await page.getByRole('button', { name: `Select ${p.symbol}`, exact: true }).click();
  }
  await page.getByRole('button', { name: 'Auto-balance' }).click();
  const positions = page.getByRole('region', { name: 'Positions' });
  // Locale-agnostic 2-dp: EN "100.00%" vs DE "100,00 %" with narrow space.
  await expect(positions.getByRole('status')).toHaveText(/^100[.,]00\s*%$/);
  await page.getByRole('button', { name: 'Activate' }).click();
  // `Activate` navigates to `/workboard/conglomerates/:id` at the *end* of
  // handleActivate, after two awaited network calls — the click resolves before
  // that, when the URL is still `/workboard/conglomerates/new`. Exclude `new`
  // from the URL match AND wait for the detail-only <h1>{name}</h1> so we
  // capture the real detail URL rather than the builder's `/new` route.
  await expect(page).toHaveURL(/\/workboard\/conglomerates\/(?!new(?:\/|$))[^/]+$/, {
    timeout: 20_000,
  });
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  return page.url();
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

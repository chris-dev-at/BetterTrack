import {
  expect,
  request as newRequestContext,
  test,
  type Locator,
  type Page,
} from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { activateConglomerate } from './support/flows';
import { provisionUser } from './support/users';

/**
 * V4-P7 custom benchmark + rebalanced backtest e2e (issue #505). One account,
 * two of their own conglomerates: `Alpha` is the basket; `Beta` a candidate
 * benchmark. On Alpha's detail page the backtest panel must accept BOTH a
 * catalog-asset benchmark picked via the local search pill AND a "my
 * conglomerates" benchmark, rendering side-by-side stat columns plus the delta
 * column both times. Switching the rebalance mode to `yearly` must fire the
 * mode-adaptive notice, surface the rebalance-markers toggle, and change the
 * basket's stats vs the buy-and-hold run.
 */

function statsTable(page: Page): Locator {
  return page.getByRole('table', { name: /Backtest statistics/i });
}

/**
 * The Basket column's Total return cell — waits for a numeric render so the read
 * never races an in-flight refetch. Assumes a benchmark is active (StatsTable).
 */
async function basketTotalReturn(page: Page): Promise<string> {
  const row = statsTable(page).locator('tr').filter({ hasText: 'Total return' });
  const cell = row.locator('td').first();
  await expect(cell).toHaveText(/[−+-]?\s*\d/, { timeout: 30_000 });
  return ((await cell.textContent()) ?? '').trim();
}

test('workboard benchmark: catalog + conglomerate benchmarks, yearly-rebalance stats change', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'benchowner');
  await apiRequest.dispose();

  const page = owner.page;

  // Two conglomerates: Alpha is the basket we backtest; Beta is a candidate
  // benchmark for the "my conglomerates" branch.
  const alphaUrl = await activateConglomerate(page, 'Alpha', [
    { query: 'Apple', symbol: 'AAPL' },
    { query: 'Microsoft', symbol: 'MSFT' },
  ]);
  await activateConglomerate(page, 'Beta', [{ query: 'SAP', symbol: 'SAP.DE' }]);
  await page.goto(alphaUrl);

  // Benchmark 1 — a catalog asset picked via the local search pill. Renders
  // two full stat columns (Basket, ticker) plus the delta column (Δ).
  await page.getByRole('button', { name: 'Search asset…' }).click();
  const benchSearch = page.getByRole('searchbox', { name: 'Search assets' });
  await benchSearch.fill('Alphabet');
  await page.getByRole('button', { name: 'Select GOOGL', exact: true }).click();
  const table1 = statsTable(page);
  await expect(table1).toBeVisible({ timeout: 30_000 });
  await expect(table1.getByRole('columnheader', { name: 'Basket' })).toBeVisible();
  await expect(table1.getByRole('columnheader', { name: 'GOOGL' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(table1.getByRole('columnheader', { name: 'Δ' })).toBeVisible();

  // Benchmark 2 — swap the catalog benchmark for one of the caller's own
  // conglomerates. Same three-column shape, labelled with the conglomerate's name.
  await page.getByRole('button', { name: 'Clear benchmark' }).click();
  await page.getByRole('button', { name: 'My conglomerates…' }).click();
  await page.getByLabel('Benchmark conglomerate').selectOption({ label: 'Beta' });
  const table2 = statsTable(page);
  await expect(table2).toBeVisible({ timeout: 30_000 });
  await expect(table2.getByRole('columnheader', { name: 'Beta' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(table2.getByRole('columnheader', { name: 'Δ' })).toBeVisible();

  // Rebalance = yearly must (a) fire the mode-adaptive notice, (b) reveal the
  // rebalance-markers toggle (only present when rebalanceEvents > 0), and (c)
  // change the basket stats from the buy-and-hold run.
  const buyAndHold = await basketTotalReturn(page);
  const rebalGroup = page.getByRole('group', { name: 'Select rebalance frequency' });
  await rebalGroup.getByRole('button', { name: 'Yearly' }).click();
  await expect(page.getByText(/Rebalanced yearly to the target weights/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel('Rebalance markers')).toBeVisible();
  const rebalanced = await basketTotalReturn(page);
  expect(rebalanced).not.toEqual(buyAndHold);

  await owner.context.close();
});

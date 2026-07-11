import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * V3-P5 multiple watchlists (issue #426, flow 4). Create a named list beside the
 * default General, then add an asset to it via the asset-search caret menu.
 * There is no active-list tab switcher — list choice happens at add-time — so
 * membership is verified on the manage-lists surface: the new list gains the
 * item, General stays empty.
 */
test('watchlists: add an asset to a second list via the caret menu', async ({ browser }) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'listowner');
  await apiRequest.dispose();

  const page = owner.page;

  // Create a second watchlist beside the locked default "General".
  await page.goto('/workboard/watchlist');
  await page.getByLabel('New watchlist').fill('Tech');
  await page.getByRole('button', { name: 'New watchlist' }).click();
  const techRow = page.getByRole('listitem').filter({ hasText: 'Tech' });
  await expect(techRow).toBeVisible({ timeout: 15_000 });

  // Add AAPL to the "Tech" list via the search-result caret menu (list choice
  // happens here, at add-time — the bookmark button alone would target General).
  await page.goto('/assets/search');
  await page.getByRole('searchbox', { name: 'Search assets' }).fill('Apple');
  await expect(page.getByRole('button', { name: 'Add AAPL to watchlist' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Choose a watchlist for AAPL' }).click();
  const listMenu = page.getByRole('menu', { name: 'Watchlists for AAPL' });
  await listMenu.getByRole('menuitem', { name: 'Tech' }).click();
  await expect(page.getByRole('button', { name: 'AAPL is on your watchlist' })).toBeVisible();

  // Verify per-list membership on the manage-lists surface: Tech has the item,
  // General stayed empty (proving the list choice was honoured).
  await page.goto('/workboard/watchlist');
  await expect(page.getByRole('listitem').filter({ hasText: 'Tech' })).toContainText('1 item', {
    timeout: 15_000,
  });
  await expect(page.getByRole('listitem').filter({ hasText: 'General' })).toContainText('0 items');

  await owner.context.close();
});

import { expect, request as newRequestContext, test } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { recordSapTrade } from './support/flows';
import { provisionUser } from './support/users';

/**
 * V3-P9 analytics compare — the missing v3 golden flow (issue #446, extends
 * PROJECTPLAN §13.3). Seed one real holding through the transaction dialog
 * (SAP.DE, the tax-at spec's EUR-native workhorse), open Portfolio → Analytics,
 * pick an asset/index benchmark (AAPL) in the Compare control, and prove the
 * side-by-side stats render — the Comparison block joins the Portfolio block,
 * doubling the Total return / CAGR / Max drawdown stat cards — plus the
 * per-asset contribution table. Assertions are structural only: the figures
 * depend on live market history, so the spec never pins a number.
 */

/** Local date `days` ago → ISO `YYYY-MM-DD`, so the buy sits inside the default 1Y window. */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


test('analytics: compare vs an index/asset shows side-by-side stats and the contribution table', async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'analytics');
  await apiRequest.dispose();

  const page = owner.page;

  // Seed a holding with history: one SAP.DE buy well inside the default 1Y range.
  await recordSapTrade(page, { side: 'buy', quantity: '5', price: '100', date: isoDaysAgo(200) });

  await page.goto('/portfolio/analytics');
  await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();

  // The portfolio stats block proves the analytics series endpoint answered.
  await expect(page.getByText('Total return', { exact: true })).toBeVisible({ timeout: 30_000 });

  // Compare vs an asset/index: pick AAPL through the Compare control's search
  // box. `exact` guards against enrichment siblings (AAPL.SW, …) — happy-path
  // precedent.
  await page
    .getByRole('group', { name: 'Compare' })
    .getByRole('button', { name: 'Asset / index' })
    .click();
  await page.getByRole('searchbox', { name: 'Search assets' }).fill('Apple');
  const selectAapl = page.getByRole('button', { name: 'Select AAPL', exact: true });
  await expect(selectAapl).toBeVisible({ timeout: 15_000 });
  await selectAapl.click();
  await expect(page.getByText('Comparing: AAPL')).toBeVisible();

  // Side-by-side stats: the Comparison block joins the Portfolio block, so each
  // stat label now appears exactly twice (server prices the benchmark live —
  // give the refetch headroom).
  await expect(page.getByText('Comparison', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Total return', { exact: true })).toHaveCount(2);
  await expect(page.getByText('CAGR', { exact: true })).toHaveCount(2);
  await expect(page.getByText('Max drawdown', { exact: true })).toHaveCount(2);

  // The per-asset contribution table (the page's only table) carries the holding.
  await expect(page.getByRole('heading', { name: 'Per-asset contribution' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Contribution', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('table').getByText('SAP.DE')).toBeVisible();

  await owner.context.close();
});

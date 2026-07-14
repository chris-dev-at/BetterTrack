import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
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

/**
 * Record one SAP.DE buy through the real "+ Transaction" dialog — the
 * tax-at.spec.ts pattern. The date↔price assist is unlinked first so the
 * entered price/date are taken verbatim; the toggle only exists once a price
 * series is available, so a failure to find it is ignored.
 */
async function recordSapBuy(
  page: Page,
  quantity: string,
  price: string,
  date: string,
): Promise<void> {
  await page.goto('/portfolio');
  await page.getByRole('button', { name: '+ Transaction' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search assets' }).fill('SAP');
  await dialog.getByRole('button', { name: 'Select SAP.DE', exact: true }).click();

  await dialog
    .getByRole('button', { name: 'Unlink date and price' })
    .click({ timeout: 20_000 })
    .catch(() => {});

  await dialog.getByLabel('Date for SAP.DE').fill(date);
  await dialog.getByLabel('Quantity for SAP.DE').fill(quantity);
  await dialog.getByLabel('Price for SAP.DE').fill(price);
  await dialog.getByRole('button', { name: 'Record buy' }).click();
  await expect(dialog).toBeHidden();
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
  await recordSapBuy(page, '5', '100', isoDaysAgo(200));

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

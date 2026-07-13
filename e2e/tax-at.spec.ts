import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * V3-P4 Austria (KESt) tax report — issue #431 (the flow moved here from #426's
 * flow 2). Enable AT tax mode through the real Settings UI, then run the owner's
 * canonical shape through the real transaction UI: realize a **+450 €** gain sell
 * (27.5 % withheld) and a **−100 € loss** sell in the SAME calendar year. The
 * same-year loss offset must REFUND part of the already-withheld tax, so the year
 * lands at 27.5 % × (450 − 100) = **96.25 € net**, with a visible **27.50 €
 * refund line** in the per-year report.
 *
 * SAP.DE is EUR-native, so realized P/L needs no FX and the numbers stay exact.
 */

/** Enable "Austria (KESt)" via Settings → Taxes and confirm it persisted. */
async function enableAustriaTaxMode(page: Page): Promise<void> {
  await page.goto('/settings/taxes');
  const austria = page.getByRole('radio', { name: /Austria \(KESt\)/i });
  await austria.check();
  await expect(austria).toBeChecked();
  // The per-year report signpost only renders once a mode is active — a live proof
  // that the choice was saved before we start recording taxable trades.
  await expect(page.getByRole('link', { name: /per-year tax report/i })).toBeVisible();
}

/**
 * Deposit EUR into Main so the automatic KESt withholding never overdraws it.
 * Driven from the Cash-sources page (its per-row Deposit works on a brand-new,
 * empty portfolio — unlike the overview button, which the empty state hides).
 */
async function depositToMain(page: Page, amount: string): Promise<void> {
  await page.goto('/portfolio/cash');
  const rows = page.locator('table[aria-label="Cash sources"] tbody tr');
  // sortSourcesMainFirst: Main is row 0 on a fresh account.
  await rows.nth(0).getByRole('button', { name: 'Deposit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cash balance' });
  await dialog.getByLabel('Amount', { exact: true }).fill(amount);
  await dialog.getByRole('button', { name: 'Deposit cash' }).click();
  await expect(dialog).toBeHidden();
  await expect(rows.nth(0)).toContainText(/1[.,]000/);
}

interface SapTrade {
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
async function recordSapTrade(page: Page, trade: SapTrade): Promise<void> {
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

test('AT tax mode: an intra-year loss sell refunds tax in the per-year report', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'taxowner');
  await apiRequest.dispose();

  const page = owner.page;

  await enableAustriaTaxMode(page);
  // Fund Main so the −123.75 € KESt withholding has cash to settle against.
  await depositToMain(page, '1000');

  // Cycle 1 — realize +450 €: buy 10 @ 100, sell 10 @ 145 → 27.5 % × 450 = 123.75 withheld.
  await recordSapTrade(page, { side: 'buy', quantity: '10', price: '100', date: '2026-02-02' });
  await recordSapTrade(page, { side: 'sell', quantity: '10', price: '145', date: '2026-03-02' });
  // Cycle 2 — realize −100 € the SAME year: buy 10 @ 100, sell 10 @ 90 → offset refunds 27.50 €.
  await recordSapTrade(page, { side: 'buy', quantity: '10', price: '100', date: '2026-04-02' });
  await recordSapTrade(page, { side: 'sell', quantity: '10', price: '90', date: '2026-05-02' });

  // The per-year report: net tax = 27.5 % × 350 = 96.25 €, with a 27.50 € refund line.
  await page.goto('/portfolio/tax');
  const table = page.getByRole('table');
  await expect(table).toContainText('2026', { timeout: 15_000 });
  const yearRow = table.getByRole('row').filter({ hasText: '2026' }).first();
  // Decimal separator is locale-dependent (de-AT `,` / en-GB `.`) — accept either.
  await expect(yearRow).toContainText(/27[.,]50/); // loss-offset refund line
  await expect(yearRow).toContainText(/96[.,]25/); // net tax for the year

  // Drill in: the year expands to its per-asset sells (SAP.DE) with their real basis.
  await page.getByRole('button', { name: /Show 2026 details/i }).click();
  await expect(page.getByText('SAP.DE').first()).toBeVisible({ timeout: 15_000 });

  await owner.context.close();
});

import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';
import { loginAsAdmin } from './support/adminApi';

/**
 * V5-P14 [E1] — German (Abgeltungsteuer) tax report end-to-end ([#734], V5-P4).
 *
 * Replays the validated `de-year-boundary-carry` domain fixture
 * (`packages/domain/src/__tests__/deTaxFixtures.ts`) through the REAL product
 * surfaces — Settings → Taxes to pick Germany, the transaction dialog for the
 * trades, the `/dividends` endpoint for the one dividend (the app has no manual
 * dividend form, per `dividends.spec.ts`), then the `/portfolio/tax` report —
 * and asserts the DE-specific report UI. The exact euro figures are the
 * fixture's hand-computed expectations, so the money math itself stays owned by
 * the domain unit tests; this spec verifies the FLOW and the DE report surfaces:
 *
 *  - **FIFO cost basis** — 2025 sells the oldest lot (5 @ €100) out of two open
 *    lots (5 @ €100, then 5 @ €300), so realized P/L is +€2,000 (FIFO) and NOT
 *    +€1,500 (moving average) — the FIFO proof the AT engine can't produce.
 *  - **Sparer-Pauschbetrag exhaustion** — 2025's gains + dividend consume the
 *    full €1,000 allowance (remaining €0), where the pure-loss 2024 leaves it
 *    unused (remaining €1,000).
 *  - **Both loss pots** — 2024's share loss and other-loss fill the Aktien
 *    (€800) and Sonstige (€300) pots; 2025 carries them IN and drains them.
 *  - **Report exports** — the per-year CSV download + printable-PDF affordances,
 *    scoped to the selected year.
 *
 * Assets are EUR-native (SAP.DE = a stock ⇒ Aktien pot; EUNL.DE = an ETF ⇒
 * Sonstige pot) so realized P/L needs no FX and the figures stay exact.
 */

/** Mutating API calls need this header or the CSRF guard 403s them (see dividends.spec). */
const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' };

/** Enable "Germany (Abgeltungsteuer)" via Settings → Taxes and confirm it persisted. */
async function enableGermanyTaxMode(page: Page): Promise<void> {
  await page.goto('/settings/taxes');
  const germany = page.getByRole('radio', { name: /Germany \(Abgeltungsteuer\)/i });
  await germany.check();
  await expect(germany).toBeChecked();
  // The per-year report signpost only renders once a mode is active — a live proof
  // the choice saved before we start recording taxable trades against it.
  await expect(page.getByRole('link', { name: /per-year tax report/i })).toBeVisible();
}

/** Deposit EUR into Main so the dividend's withholding never trips the overdraw gate. */
async function depositToMain(page: Page, amount: string): Promise<void> {
  await page.goto('/portfolio/cash-flow/accounts');
  const rows = page.locator('table[aria-label="Cash sources"] tbody tr');
  // sortSourcesMainFirst: Main is row 0 on a fresh account.
  await rows.nth(0).getByRole('button', { name: 'Deposit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cash balance' });
  await dialog.getByLabel('Amount', { exact: true }).fill(amount);
  await dialog.getByRole('button', { name: 'Deposit cash' }).click();
  await expect(dialog).toBeHidden();
  await expect(rows.nth(0)).toContainText(/50[.,]000/);
}

interface Trade {
  symbol: string;
  /** Search query that surfaces `symbol` in the local catalog. */
  query: string;
  side: 'buy' | 'sell';
  quantity: string;
  price: string;
  /** ISO `YYYY-MM-DD`; distinct dates keep the realized-P/L ordering unambiguous. */
  date: string;
}

/**
 * Record one trade through the real "+ Transaction" dialog. Mirrors
 * `support/flows.ts#recordSapTrade` but is symbol-parameterized (this spec
 * trades a stock AND an ETF). The date↔price assist is unlinked first so the
 * entered price/date are taken verbatim; the price is filled LAST so even a
 * still-linked assist can't overwrite it.
 */
async function recordTrade(page: Page, trade: Trade): Promise<void> {
  await page.goto('/portfolio');
  await page.getByRole('button', { name: '+ Transaction' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search assets' }).fill(trade.query);
  await dialog.getByRole('button', { name: `Select ${trade.symbol}`, exact: true }).click();

  await dialog
    .getByRole('button', { name: 'Unlink date and price' })
    .click({ timeout: 20_000 })
    .catch(() => {});

  if (trade.side === 'sell') await dialog.getByRole('button', { name: 'Sell' }).click();
  await dialog.getByLabel(`Date for ${trade.symbol}`).fill(trade.date);
  await dialog.getByLabel(`Quantity for ${trade.symbol}`).fill(trade.quantity);
  await dialog.getByLabel(`Price for ${trade.symbol}`).fill(trade.price);
  await dialog
    .getByRole('button', { name: trade.side === 'sell' ? 'Record sell' : 'Record buy' })
    .click();
  await expect(dialog).toBeHidden();
}

/**
 * The fixture trades, chronological (each sell after its lot's buy). SAP.DE holds
 * the Aktien flow (2024 loss, then a two-lot 2025 gain that proves FIFO); EUNL.DE
 * holds the 2024 Sonstige loss. The 2025 second SAP lot (5 @ €300) stays open —
 * FIFO leaves it untouched — so it changes nothing but makes FIFO ≠ average.
 */
const TRADES: Trade[] = [
  { symbol: 'SAP.DE', query: 'SAP', side: 'buy', quantity: '10', price: '200', date: '2024-02-12' },
  {
    symbol: 'EUNL.DE',
    query: 'EUNL',
    side: 'buy',
    quantity: '10',
    price: '100',
    date: '2024-03-05',
  },
  {
    symbol: 'SAP.DE',
    query: 'SAP',
    side: 'sell',
    quantity: '10',
    price: '120',
    date: '2024-06-10',
  },
  {
    symbol: 'EUNL.DE',
    query: 'EUNL',
    side: 'sell',
    quantity: '10',
    price: '70',
    date: '2024-10-14',
  },
  { symbol: 'SAP.DE', query: 'SAP', side: 'buy', quantity: '5', price: '100', date: '2025-01-20' },
  { symbol: 'SAP.DE', query: 'SAP', side: 'buy', quantity: '5', price: '300', date: '2025-01-25' },
  { symbol: 'SAP.DE', query: 'SAP', side: 'sell', quantity: '5', price: '500', date: '2025-05-11' },
];

/** The `<dd>` value of a DE year-block stat, located by its `<dt>` label text. */
function deStatValue(page: Page, label: string) {
  return page.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');
}

test('DE tax mode: FIFO, Sparer-Pauschbetrag exhaustion, both loss pots, and report exports', async ({
  browser,
}) => {
  test.setTimeout(240_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'detaxowner');
  await apiRequest.dispose();

  const page = owner.page;
  const api = owner.context.request;

  await enableGermanyTaxMode(page);
  // Fund Main generously so the 2025 dividend's withholding never overdraws it.
  await depositToMain(page, '50000');

  for (const trade of TRADES) await recordTrade(page, trade);

  // The one dividend (fixture `d1`, 2025) drives the year over its allowance.
  // There is no manual dividend form — record it through the real endpoint on the
  // owner's own session (its cookie jar), on the held SAP.DE. Dividends are always
  // Sonstige-side income regardless of the asset type.
  const portfoliosRes = await api.get(`${API_BASE_URL}/api/v1/portfolios`);
  expect(portfoliosRes.ok(), await portfoliosRes.text()).toBeTruthy();
  const portfolios = (
    (await portfoliosRes.json()) as { portfolios: { id: string; isDefault: boolean }[] }
  ).portfolios;
  const pid = (portfolios.find((p) => p.isDefault) ?? portfolios[0]!).id;

  const detailRes = await api.get(`${API_BASE_URL}/api/v1/portfolios/${pid}`);
  expect(detailRes.ok(), await detailRes.text()).toBeTruthy();
  const holdings = (
    (await detailRes.json()) as { holdings: { asset: { id: string; symbol: string } }[] }
  ).holdings;
  const sap = holdings.find((h) => h.asset.symbol === 'SAP.DE');
  expect(sap, 'SAP.DE holding present for the dividend').toBeTruthy();

  const divRes = await api.post(`${API_BASE_URL}/api/v1/portfolios/${pid}/dividends`, {
    headers: CSRF_HEADERS,
    data: { assetId: sap!.asset.id, grossAmountEur: 400, executedAt: '2025-03-01T12:00:00.000Z' },
  });
  expect(divRes.status(), await divRes.text()).toBe(201);

  // ── The report ────────────────────────────────────────────────────────────
  await page.goto('/portfolio/tax');
  const table = page.getByRole('table');
  await expect(table).toContainText('2025', { timeout: 15_000 });
  await expect(table).toContainText('2024');

  // 2025 — allowance EXHAUSTED, both pots carried IN and drained, FIFO gain.
  await page.getByRole('button', { name: 'Show 2025 details' }).click();
  await expect(page.getByText('Germany (Abgeltungsteuer)').first()).toBeVisible({
    timeout: 15_000,
  });
  // Sparer-Pauschbetrag: the full €1,000 is used, €0 remains.
  await expect(deStatValue(page, 'Allowance used')).toContainText(/1[.,]000/);
  await expect(deStatValue(page, 'Allowance remaining')).toContainText(/0[.,]00/);
  await expect(deStatValue(page, 'Allowance remaining')).not.toContainText(/1[.,]000/);
  // Both pots carry IN the prior year's losses (Aktien €800, Sonstige €300).
  await expect(deStatValue(page, /Share-loss pot/)).toContainText(/800/);
  await expect(deStatValue(page, /Other-loss pot/)).toContainText(/300/);
  // FIFO: the 2025 sell realizes +€2,000 (oldest 5 @ €100 lot), never the +€1,500
  // a moving-average basis (½·(€100+€300)) would have produced. The per-sell
  // table is the only one carrying a "Cost basis" column, so it resolves alone.
  const sellsTable = page.locator('table').filter({ hasText: 'Cost basis' });
  await expect(sellsTable).toContainText(/2[.,]000/);
  await expect(sellsTable).not.toContainText(/1[.,]500/);

  // Report exports (V5-P4b), scoped to the selected year 2025.
  const csv = page.getByRole('link', { name: 'Export CSV' });
  await expect(csv).toBeVisible();
  await expect(csv).toHaveAttribute('href', /\/tax-years\/2025\/export\.csv/);
  await expect(csv).toHaveAttribute('download', /.*/);
  const print = page.getByRole('link', { name: 'Print / PDF' });
  await expect(print).toBeVisible();
  const printHref = await print.getAttribute('href');
  expect(printHref).toContain('year=2025');

  // 2024 — pure-loss year: allowance UNUSED, both pots FILL (Aktien €800,
  // Sonstige €300). Expanding 2024 collapses 2025 (single-open report).
  await page.getByRole('button', { name: 'Show 2024 details' }).click();
  await expect(deStatValue(page, 'Allowance remaining')).toContainText(/1[.,]000/);
  await expect(deStatValue(page, /Share-loss pot/)).toContainText(/800/);
  await expect(deStatValue(page, /Other-loss pot/)).toContainText(/300/);

  // The printable-PDF view renders for the selected year (the affordance works).
  await page.goto(printHref!);
  await expect(page.getByText('2025').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible();

  await owner.context.close();
});

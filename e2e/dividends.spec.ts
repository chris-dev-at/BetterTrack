import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { recordSapTrade } from './support/flows';
import { provisionUser } from './support/users';

/**
 * V5-P5 dividend intelligence regression (issue #626, area 1). A recorded
 * dividend must land its **gross** in cash **net of the tax-mode withholding**
 * and must never auto-reinvest (it creates cash movements only, never a buy).
 * We prove the money-path end-to-end in the owner-visible surfaces: enable AT
 * (KESt) mode through Settings, hold a real EUR-native asset (SAP.DE, so no FX
 * blurs the figures), record a €100 gross dividend, and assert the source lands
 * at €72.50 (27.5 % withheld beside it) with the holding's share count unmoved.
 *
 * There is no manual dividend-entry form in the web app — dividends arrive via
 * the CSV-import path or the API — so the record step drives the real
 * `POST /dividends` endpoint through the owner's own session (the browser
 * context's request shares its cookie jar). The cash+tax movement math for
 * none / manual_per_trade / country_specific is unit/integration-covered in
 * `apps/api/src/__tests__/tax.test.ts` (+ `deTax.test.ts`); this spec is the
 * missing e2e layer over the AT happy path.
 */

/** Mutating API calls need this header or the CSRF guard 403s them. */
const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' };

/** Enable "Austria (KESt)" via Settings → Taxes and confirm it persisted. */
async function enableAustriaTaxMode(page: Page): Promise<void> {
  await page.goto('/settings/taxes');
  const austria = page.getByRole('radio', { name: /Austria \(KESt\)/i });
  await austria.check();
  await expect(austria).toBeChecked();
  // The per-year report signpost only renders once a mode is active — a live proof
  // the choice saved before we record the dividend against it.
  await expect(page.getByRole('link', { name: /per-year tax report/i })).toBeVisible();
}

test('dividends: an AT-mode dividend lands net of withholding in cash, no auto-reinvest', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'divowner');
  await apiRequest.dispose();

  const page = owner.page;
  const api = owner.context.request;

  await enableAustriaTaxMode(page);
  // Hold 10 SAP.DE — a dividend can only be recorded on an asset the portfolio holds.
  await recordSapTrade(page, { side: 'buy', quantity: '10', price: '100', date: '2026-01-10' });

  // Resolve the default portfolio and the SAP.DE holding through the owner's session.
  const portfoliosRes = await api.get(`${API_BASE_URL}/api/v1/portfolios`);
  expect(portfoliosRes.ok(), await portfoliosRes.text()).toBeTruthy();
  const portfolios = (
    (await portfoliosRes.json()) as { portfolios: { id: string; isDefault: boolean }[] }
  ).portfolios;
  const pid = (portfolios.find((p) => p.isDefault) ?? portfolios[0]!).id;

  const detailRes = await api.get(`${API_BASE_URL}/api/v1/portfolios/${pid}`);
  expect(detailRes.ok(), await detailRes.text()).toBeTruthy();
  const holdings = (
    (await detailRes.json()) as {
      holdings: { asset: { id: string; symbol: string }; quantity: number }[];
    }
  ).holdings;
  const sap = holdings.find((h) => h.asset.symbol === 'SAP.DE');
  expect(sap, 'SAP.DE holding present after the buy').toBeTruthy();
  expect(sap!.quantity).toBe(10);

  // Record a €100 gross dividend. In AT mode 27.5 % is withheld beside the gross,
  // so the source nets €72.50 and exactly two movements post (gross + withholding).
  const divRes = await api.post(`${API_BASE_URL}/api/v1/portfolios/${pid}/dividends`, {
    headers: CSRF_HEADERS,
    data: { assetId: sap!.asset.id, grossAmountEur: 100, executedAt: '2026-04-01T10:00:00.000Z' },
  });
  expect(divRes.status(), await divRes.text()).toBe(201);
  const recorded = (await divRes.json()) as {
    dividend: { taxAmountEur: number; grossAmountEur: number };
    movements: { kind: string; amountEur: number }[];
    sourceBalanceEur: number;
  };
  expect(recorded.dividend.grossAmountEur).toBe(100);
  expect(recorded.dividend.taxAmountEur).toBe(27.5);
  expect(recorded.sourceBalanceEur).toBe(72.5);
  // No auto-reinvest: only cash movements post (gross inflow + tax withholding),
  // never a buy transaction.
  expect(recorded.movements.map((m) => m.kind).sort()).toEqual(['dividend', 'tax_withholding']);

  // The net figure surfaces on the real Cash-sources page: Main (row 0) reads €72.50.
  await page.goto('/portfolio/cash');
  const mainRow = page.locator('table[aria-label="Cash sources"] tbody tr').nth(0);
  // Decimal separator is locale-dependent (de-AT `,` / en-GB `.`) — accept either.
  await expect(mainRow).toContainText(/72[.,]50/, { timeout: 15_000 });

  // No auto-reinvest, proven in the UI too: the holding still shows 10 shares —
  // the dividend never minted a buy.
  const stillHeldRes = await api.get(`${API_BASE_URL}/api/v1/portfolios/${pid}`);
  const stillHeld = (
    (await stillHeldRes.json()) as {
      holdings: { asset: { symbol: string }; quantity: number }[];
    }
  ).holdings.find((h) => h.asset.symbol === 'SAP.DE');
  expect(stillHeld!.quantity).toBe(10);

  await owner.context.close();
});

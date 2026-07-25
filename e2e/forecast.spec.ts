import { expect, request as newRequestContext, test, type Page } from '@playwright/test';

import { loginAsAdmin } from './support/adminApi';
import { API_BASE_URL } from './support/config';
import { provisionUser } from './support/users';

/**
 * V5-P14's standing-order + Forecast gate. A recurring cash-add standing order
 * ("salary") is created through the real Forecast UI and must (a) show up with
 * its amount and schedule and (b) move the net-worth projection only after the
 * user enables the standing-orders factor.
 *
 * Kept to a tight happy path (the nightly per-test budget is real). The
 * scheduling edge cases (exactly-once booking, catch-up, clamp, pause/resume,
 * overdraw) live in `apps/api/src/services/standingOrders/__tests__/**` and the
 * projection math in `apps/web/src/user/forecast/projection.test.ts`; this spec
 * is the browser layer wiring the create UI to the projection surface.
 */

/**
 * The browser clock anchors Forecast's client-side `asOf` date. The scheduled
 * start date stays ahead of the API process's real clock, so the server's
 * next-run calculation is stable too. With no return/dividend factor and a
 * €500 monthly cash-add, the one-year horizon is exactly €6,000.
 */
const FORECAST_NOW = '2090-01-10T12:00:00.000Z';
const ORDER_START_DATE = '2090-02-15';
const ONE_YEAR_SALARY_TOTAL = '6,000.00 €';

/**
 * Pin the optional market-backed reads to empty, contract-valid fixtures. The
 * scenario starts with a fresh zero-value portfolio, but routing these reads
 * also makes that fact explicit: this gate never waits on a live provider or a
 * server-side market-data cache.
 */
async function pinForecastInputs(page: Page): Promise<{ assertUsed: () => void }> {
  let analyticsRequests = 0;
  let dividendProjectionRequests = 0;

  await page.clock.setFixedTime(FORECAST_NOW);

  await page.route(
    /\/api\/v1\/analytics\/portfolios\/([^/?]+)\/series(?:\?.*)?$/,
    async (route) => {
      const url = new URL(route.request().url());
      const portfolioId = url.pathname.match(/\/analytics\/portfolios\/([^/]+)\/series$/)?.[1];
      if (!portfolioId) throw new Error(`Unexpected analytics URL: ${url}`);

      analyticsRequests += 1;
      await route.fulfill({
        json: {
          portfolioId,
          baseCurrency: 'EUR',
          mode: url.searchParams.get('mode') === 'perf' ? 'perf' : 'value',
          from: '2090-01-10',
          to: '2090-01-10',
          inflation: null,
          inflationPresets: [],
          primary: {
            kind: 'portfolio',
            label: 'Main',
            points: [],
            stats: {
              totalReturnPct: 0,
              cagrPct: null,
              maxDrawdownPct: 0,
              bestDay: null,
              worstDay: null,
            },
          },
          compare: null,
          contributions: [],
        },
      });
    },
  );

  await page.route('**/api/v1/assets/portfolio/dividend-projection', async (route) => {
    dividendProjectionRequests += 1;
    await route.fulfill({
      json: {
        available: false,
        currency: 'EUR',
        monthlyTotalEur: 0,
        yearlyTotalEur: 0,
        holdings: [],
      },
    });
  });

  return {
    assertUsed: () => {
      expect(analyticsRequests, 'Forecast should use the pinned analytics fixture').toBeGreaterThan(
        0,
      );
      expect(
        dividendProjectionRequests,
        'Forecast should use the pinned dividend fixture',
      ).toBeGreaterThan(0);
    },
  };
}

test('forecast: a scheduled cash-add lifts the enabled one-year projection', async ({
  browser,
}) => {
  test.setTimeout(120_000);

  const apiRequest = await newRequestContext.newContext({ baseURL: API_BASE_URL });
  await loginAsAdmin(apiRequest);
  const owner = await provisionUser(browser, apiRequest, 'forecastowner');
  await apiRequest.dispose();

  const page = owner.page;
  const fixtures = await pinForecastInputs(page);

  try {
    await page.goto('/forecast');

    const baseLegend = page.getByTestId('projection-series-base');
    const returnFactor = page.getByRole('checkbox', { name: 'Average return' });
    const ordersFactor = page.getByRole('checkbox', { name: 'Standing orders' });
    await expect(baseLegend).toBeVisible({ timeout: 15_000 });

    // A fresh default portfolio is the deterministic €0 cash/net-worth fixture.
    // Disable every factor first, then explicitly enable standing orders once the
    // real UI flow has persisted its scheduled €500 monthly contribution.
    await page.getByLabel('Horizon (years)').fill('1');
    await returnFactor.uncheck();
    await ordersFactor.uncheck();
    await expect(baseLegend).toContainText('0.00 €');

    // Create the recurring contribution through the real dialog, with a fixed
    // schedule rather than relying on the API's default "today" start date.
    await page.getByRole('button', { name: 'New standing order' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Add cash' }).click();
    await dialog.getByLabel('Amount (€)').fill('500');
    await dialog.getByLabel('Label (optional)').fill('salary');
    await dialog.getByLabel('Day of month').fill('15');
    await dialog.getByLabel('Start date').fill(ORDER_START_DATE);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).toBeHidden();

    // The row proves the persisted user-facing schedule and amount, not merely
    // that a standing-order request returned successfully.
    const section = page.getByRole('region', { name: /standing orders/i });
    const row = section.getByRole('listitem').filter({ hasText: 'salary' });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('Active');
    await expect(row).toContainText('Add 500.00 €');
    await expect(row).toContainText('Monthly on day 15');
    await expect(row).toContainText('Next run: 15 Feb 2090');

    // The persisted order is deliberately inert while its factor is disabled.
    await expect(ordersFactor).not.toBeChecked();
    await expect(baseLegend).toContainText('0.00 €');

    // Enabling the factor changes the real browser projection in the expected
    // positive direction and exposes the exact one-year scheduled contribution.
    await ordersFactor.check();
    await expect(ordersFactor).toBeChecked();
    await expect(baseLegend).toContainText(ONE_YEAR_SALARY_TOTAL, { timeout: 15_000 });
    fixtures.assertUsed();
  } finally {
    await owner.context.close();
  }
});
